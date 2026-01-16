// Trulia Real Estate Scraper - Production-grade Apify Actor
// Uses CheerioCrawler with stealth headers for maximum performance

import { Actor, log } from 'apify';
import { CheerioCrawler, Dataset } from 'crawlee';
import { HeaderGenerator } from 'header-generator';

await Actor.init();

async function main() {
    try {
        const input = (await Actor.getInput()) || {};
        const {
            start_url,
            location = 'NY',
            listing_type = 'buy',
            results_wanted: RESULTS_WANTED_RAW = 20,
            max_pages: MAX_PAGES_RAW = 5,
            proxyConfiguration,
        } = input;

        const RESULTS_WANTED = Number.isFinite(+RESULTS_WANTED_RAW) ? Math.max(1, +RESULTS_WANTED_RAW) : 20;
        const MAX_PAGES = Number.isFinite(+MAX_PAGES_RAW) ? Math.max(1, +MAX_PAGES_RAW) : 5;

        // Initialize header generator with latest browser versions for stealth
        const headerGenerator = new HeaderGenerator({
            browsers: [
                { name: 'chrome', minVersion: 120, maxVersion: 130 },
                { name: 'firefox', minVersion: 115, maxVersion: 125 }
            ],
            devices: ['desktop'],
            operatingSystems: ['windows', 'macos'],
            locales: ['en-US', 'en'],
        });

        // Build start URL
        const buildStartUrl = (loc, type) => {
            // Trulia URL patterns:
            // Buy: https://www.trulia.com/NY/
            // Rent: https://www.trulia.com/for_rent/NY/
            const base = 'https://www.trulia.com';
            const locPath = encodeURIComponent(loc.toUpperCase());
            if (type === 'rent') {
                return `${base}/for_rent/${locPath}/`;
            }
            return `${base}/${locPath}/`;
        };

        const initialUrl = start_url || buildStartUrl(location, listing_type);

        const proxyConf = proxyConfiguration
            ? await Actor.createProxyConfiguration({ ...proxyConfiguration })
            : undefined;

        let saved = 0;
        const seenUrls = new Set();

        // Priority 1: Extract data from __NEXT_DATA__ JSON (Next.js site)
        function extractFromNextData($) {
            try {
                const scriptData = $('script#__NEXT_DATA__').text();
                if (!scriptData) return null;

                const json = JSON.parse(scriptData);
                const props = json?.props?.pageProps;
                if (!props) return null;

                // Look for search results in various possible locations
                const searchData = props?.searchData ||
                    props?.searchResults ||
                    props?.homes ||
                    props?.listings;

                if (!searchData) return null;

                const homes = searchData?.homes ||
                    searchData?.results ||
                    searchData?.listings ||
                    (Array.isArray(searchData) ? searchData : null);

                if (!homes || !Array.isArray(homes)) return null;

                return homes.map(home => ({
                    price: home.price?.formattedPrice || home.price?.value?.toString() || home.listingPrice || null,
                    beds: home.bedrooms?.toString() || home.beds?.toString() || null,
                    baths: home.bathrooms?.toString() || home.baths?.toString() || null,
                    sqft: home.floorSpace?.formattedDimension || home.sqft?.toString() || home.livingArea?.toString() || null,
                    lot_size: home.lotSize?.formattedDimension || home.lotSize?.value?.toString() || null,
                    address: home.address?.formattedAddress || home.fullAddress || home.streetAddress || null,
                    city: home.address?.city || home.city || null,
                    state: home.address?.stateCode || home.state || null,
                    zip_code: home.address?.postalCode || home.zipCode || null,
                    property_type: home.propertyType || home.homeType || null,
                    listing_by: home.listingAgent?.name || home.broker?.name || home.attribution?.listingAgent || null,
                    image_url: home.media?.[0]?.url || home.photos?.[0]?.url || home.heroImage?.url || null,
                    url: home.url ? `https://www.trulia.com${home.url.startsWith('/') ? '' : '/'}${home.url}` : null,
                }));
            } catch (e) {
                log.debug(`__NEXT_DATA__ parsing failed: ${e.message}`);
                return null;
            }
        }

        // Priority 2: Extract from HTML property cards
        function extractFromHtml($, baseUrl) {
            const listings = [];

            // Trulia property card selectors - multiple fallbacks
            const cardSelectors = [
                '[data-testid="property-card"]',
                '[data-testid="search-result-card"]',
                'li[data-testid]',
                '.PropertyCard',
                '[class*="PropertyCard"]',
                'article[data-testid]',
                '.Grid__CellBox-sc-14bsf65-0'
            ];

            let cards = $([]);
            for (const selector of cardSelectors) {
                cards = $(selector);
                if (cards.length > 0) {
                    log.debug(`Found ${cards.length} cards with selector: ${selector}`);
                    break;
                }
            }

            cards.each((_, card) => {
                try {
                    const $card = $(card);

                    // Price extraction
                    const priceText = $card.find('[data-testid="property-price"], [class*="Price"], .Text-sc-aiai24-0').first().text().trim();
                    const price = priceText.match(/\$[\d,]+\+?/)?.[0] || priceText || null;

                    // Beds/Baths/Sqft - often in a single line like "3 Beds  2 Baths  1,654 sqft"
                    const detailsText = $card.find('[data-testid="property-beds"], [data-testid="property-baths"], [data-testid="property-floorSpace"], [class*="detail"], ul').text();
                    const bedsMatch = detailsText.match(/(\d+)\s*Beds?/i);
                    const bathsMatch = detailsText.match(/(\d+(?:\.\d+)?)\s*Baths?/i);
                    const sqftMatch = detailsText.match(/([\d,]+)\s*sqft/i);

                    // Lot size (often shown as badge like "0.88 ACRES")
                    const lotText = $card.find('[class*="Badge"], [class*="lot"]').text();
                    const lotMatch = lotText.match(/([\d.]+)\s*ACRES?/i);

                    // Address extraction
                    const addressEl = $card.find('[data-testid="property-address"], [class*="Address"], address, .Text-sc-aiai24-0').filter((_, el) => {
                        const text = $(el).text();
                        return /\d+.*[A-Z]{2}\s*\d{5}/.test(text) || /,\s*[A-Z]{2}/.test(text);
                    }).first();
                    const fullAddress = addressEl.text().trim() || $card.find('address').text().trim();

                    // Parse address components
                    const addressParts = fullAddress.split(',').map(s => s.trim());
                    const streetAddress = addressParts[0] || null;
                    const cityStateZip = addressParts.slice(1).join(', ');
                    const stateZipMatch = cityStateZip.match(/([A-Z]{2})\s*(\d{5})?/);

                    // Property URL
                    const linkEl = $card.find('a[href*="/p/"], a[href*="/home/"]').first();
                    let propertyUrl = linkEl.attr('href') || null;
                    if (propertyUrl && !propertyUrl.startsWith('http')) {
                        propertyUrl = new URL(propertyUrl, baseUrl).href;
                    }

                    // Image URL
                    const imgEl = $card.find('img[src*="trulia"], img[data-src], picture img').first();
                    const imageUrl = imgEl.attr('src') || imgEl.attr('data-src') || null;

                    // Listing source
                    const listingBy = $card.find('[class*="attribution"], [class*="broker"], [class*="listing"]').text().replace(/LISTING BY:?/i, '').trim() || null;

                    // Property type badges
                    const badges = $card.find('[class*="Badge"]').map((_, el) => $(el).text().trim()).get();
                    const propertyType = badges.find(b => /NEW CONSTRUCTION|BUILDABLE|FORECLOSURE|FOR SALE|FOR RENT/i.test(b)) || null;

                    if (price || streetAddress || propertyUrl) {
                        listings.push({
                            price: price,
                            beds: bedsMatch?.[1] || null,
                            baths: bathsMatch?.[1] || null,
                            sqft: sqftMatch?.[1]?.replace(/,/g, '') || null,
                            lot_size: lotMatch ? `${lotMatch[1]} acres` : null,
                            address: streetAddress,
                            city: addressParts[1]?.replace(/,?\s*[A-Z]{2}\s*\d{5}.*/, '').trim() || null,
                            state: stateZipMatch?.[1] || null,
                            zip_code: stateZipMatch?.[2] || null,
                            property_type: propertyType,
                            listing_by: listingBy,
                            image_url: imageUrl,
                            url: propertyUrl,
                        });
                    }
                } catch (e) {
                    log.debug(`Card parsing error: ${e.message}`);
                }
            });

            return listings;
        }

        // Find next page URL
        function findNextPage($, currentUrl, currentPage) {
            // Try standard pagination links
            const nextLink = $('a[rel="next"], [data-testid="pagination-next"], a[aria-label*="Next"]').attr('href');
            if (nextLink) {
                return nextLink.startsWith('http') ? nextLink : new URL(nextLink, currentUrl).href;
            }

            // Try page number in URL
            const urlObj = new URL(currentUrl);
            const nextPageNum = currentPage + 1;

            // Check for existing page param
            if (urlObj.pathname.includes(`/${currentPage}_p/`)) {
                return currentUrl.replace(`/${currentPage}_p/`, `/${nextPageNum}_p/`);
            }

            // Add page param
            if (!urlObj.pathname.includes('_p/')) {
                const basePath = urlObj.pathname.replace(/\/$/, '');
                urlObj.pathname = `${basePath}/${nextPageNum}_p/`;
                return urlObj.href;
            }

            return null;
        }

        const crawler = new CheerioCrawler({
            proxyConfiguration: proxyConf,
            maxRequestRetries: 5,
            maxConcurrency: 3,  // Lower for stealth
            requestHandlerTimeoutSecs: 60,
            useSessionPool: true,
            sessionPoolOptions: {
                maxPoolSize: 50,
                sessionOptions: {
                    maxUsageCount: 10,  // Aggressive session rotation
                    maxErrorScore: 3,
                },
            },

            preNavigationHooks: [
                async ({ request }) => {
                    // Generate stealth headers
                    const headers = headerGenerator.getHeaders({
                        operatingSystems: ['windows'],
                        browsers: ['chrome'],
                        devices: ['desktop'],
                        locales: ['en-US'],
                    });

                    request.headers = {
                        ...headers,
                        'sec-ch-ua': '"Chromium";v="122", "Not(A:Brand";v="24", "Google Chrome";v="122"',
                        'sec-ch-ua-mobile': '?0',
                        'sec-ch-ua-platform': '"Windows"',
                        'sec-ch-ua-platform-version': '"15.0.0"',
                        'sec-fetch-dest': 'document',
                        'sec-fetch-mode': 'navigate',
                        'sec-fetch-site': 'none',
                        'sec-fetch-user': '?1',
                        'upgrade-insecure-requests': '1',
                        'accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
                        'accept-language': 'en-US,en;q=0.9',
                        'accept-encoding': 'gzip, deflate, br',
                        'cache-control': 'max-age=0',
                    };

                    // Human-like random delay
                    const delay = Math.random() * 2000 + 1000;
                    await new Promise(resolve => setTimeout(resolve, delay));
                },
            ],

            async requestHandler({ request, $, enqueueLinks, session }) {
                const pageNo = request.userData?.pageNo || 1;
                log.info(`Processing page ${pageNo}: ${request.url}`);

                let listings = [];

                // Priority 1: Try JSON extraction from __NEXT_DATA__
                const jsonListings = extractFromNextData($);
                if (jsonListings && jsonListings.length > 0) {
                    log.info(`Extracted ${jsonListings.length} listings from __NEXT_DATA__`);
                    listings = jsonListings;
                } else {
                    // Priority 2: Fall back to HTML parsing
                    listings = extractFromHtml($, request.url);
                    log.info(`Extracted ${listings.length} listings from HTML`);
                }

                // Deduplicate and save
                const newListings = [];
                for (const listing of listings) {
                    if (saved >= RESULTS_WANTED) break;

                    const key = listing.url || listing.address;
                    if (key && !seenUrls.has(key)) {
                        seenUrls.add(key);
                        newListings.push(listing);
                        saved++;
                    }
                }

                if (newListings.length > 0) {
                    await Dataset.pushData(newListings);
                    log.info(`Saved ${newListings.length} listings (total: ${saved})`);
                }

                // Natural browsing delay
                const browseTime = Math.random() * 2000 + 1500;
                await new Promise(resolve => setTimeout(resolve, browseTime));

                // Pagination
                if (saved < RESULTS_WANTED && pageNo < MAX_PAGES) {
                    const nextUrl = findNextPage($, request.url, pageNo);
                    if (nextUrl && !seenUrls.has(nextUrl)) {
                        seenUrls.add(nextUrl);
                        await enqueueLinks({
                            urls: [nextUrl],
                            userData: { pageNo: pageNo + 1 },
                        });
                        log.info(`Enqueued next page: ${nextUrl}`);
                    }
                }
            },

            failedRequestHandler({ request }, error) {
                log.error(`Request failed: ${request.url} - ${error.message}`);
            },
        });

        log.info(`Starting Trulia scraper for: ${initialUrl}`);
        log.info(`Results wanted: ${RESULTS_WANTED}, Max pages: ${MAX_PAGES}`);

        await crawler.run([{ url: initialUrl, userData: { pageNo: 1 } }]);

        log.info(`Finished. Saved ${saved} listings.`);
    } finally {
        await Actor.exit();
    }
}

main().catch(err => {
    log.error(err.message);
    process.exit(1);
});
