// Trulia Real Estate Scraper - Production-grade Apify Actor
// Fast, stealthy, cheap - uses __NEXT_DATA__ JSON extraction (no browser needed)

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

        // Stealth header generator - latest browser versions
        const headerGenerator = new HeaderGenerator({
            browsers: [
                { name: 'chrome', minVersion: 120, maxVersion: 130 },
                { name: 'firefox', minVersion: 115, maxVersion: 125 }
            ],
            devices: ['desktop'],
            operatingSystems: ['windows', 'macos'],
            locales: ['en-US', 'en'],
        });

        // Build Trulia URL
        const buildStartUrl = (loc, type) => {
            const base = 'https://www.trulia.com';
            const locPath = encodeURIComponent(loc.toUpperCase().replace(/\s+/g, '_'));
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

        /**
         * Extract listings from __NEXT_DATA__ JSON
         * Trulia stores all listing data in this Next.js hydration script
         * Path: props.searchData.homes (array of property objects)
         */
        function extractFromNextData($) {
            try {
                const scriptEl = $('script#__NEXT_DATA__');
                if (!scriptEl.length) {
                    log.debug('No __NEXT_DATA__ found');
                    return null;
                }

                const json = JSON.parse(scriptEl.text());

                // Trulia stores data at props.searchData.homes
                const searchData = json?.props?.searchData || json?.props?.pageProps?.searchData;

                if (!searchData) {
                    log.debug('No searchData in __NEXT_DATA__', { keys: Object.keys(json?.props || {}) });
                    return null;
                }

                const homes = searchData.homes;
                if (!homes || !Array.isArray(homes)) {
                    log.debug('No homes array in searchData');
                    return null;
                }

                log.info(`Found ${homes.length} homes in __NEXT_DATA__`);

                return homes.map(home => ({
                    // Price
                    price: home.price?.formattedPrice ||
                        (home.price?.price ? `$${home.price.price.toLocaleString()}` : null),

                    // Property details
                    beds: home.bedrooms?.formattedValue?.replace(/\s*Beds?/i, '') ||
                        home.bedrooms?.value?.toString() || null,
                    baths: home.bathrooms?.formattedValue?.replace(/\s*Baths?/i, '') ||
                        home.bathrooms?.value?.toString() || null,
                    sqft: home.floorSpace?.formattedDimension?.replace(/\s*sqft/i, '').replace(/,/g, '') ||
                        home.floorSpace?.value?.toString() || null,
                    lot_size: home.lotSize?.formattedDimension || null,

                    // Location
                    address: home.location?.streetAddress ||
                        home.location?.formattedStreetLine || null,
                    city: home.location?.city || null,
                    state: home.location?.stateCode || null,
                    zip_code: home.location?.zipCode || null,
                    full_address: home.location?.fullLocation || null,
                    latitude: home.location?.coordinates?.latitude || null,
                    longitude: home.location?.coordinates?.longitude || null,

                    // Property info
                    property_type: home.propertyType?.value ||
                        home.propertyType?.formattedValue || null,

                    // Listing details
                    listing_by: home.activeListing?.provider?.broker?.name ||
                        home.attribution?.listingAgent || null,
                    description: home.description?.value || null,

                    // Media
                    image_url: home.media?.heroImage?.url?.medium ||
                        home.media?.photos?.[0]?.url?.medium || null,

                    // URL - make absolute
                    url: home.url ? `https://www.trulia.com${home.url.startsWith('/') ? '' : '/'}${home.url}` : null,
                }));
            } catch (e) {
                log.warning(`__NEXT_DATA__ parsing error: ${e.message}`);
                return null;
            }
        }

        /**
         * Fallback: Extract from JSON-LD structured data
         */
        function extractFromJsonLd($) {
            const listings = [];

            $('script[type="application/ld+json"]').each((_, el) => {
                try {
                    const json = JSON.parse($(el).text());
                    const items = Array.isArray(json) ? json : [json];

                    for (const item of items) {
                        if (item['@type'] === 'RealEstateListing' ||
                            item['@type'] === 'Product' ||
                            item['@type']?.includes?.('RealEstateListing')) {
                            listings.push({
                                price: item.offers?.price || item.price || null,
                                address: item.address?.streetAddress || item.name || null,
                                city: item.address?.addressLocality || null,
                                state: item.address?.addressRegion || null,
                                zip_code: item.address?.postalCode || null,
                                url: item.url || null,
                                image_url: item.image || null,
                            });
                        }
                    }
                } catch (e) {
                    // Ignore malformed JSON-LD
                }
            });

            return listings.length > 0 ? listings : null;
        }

        /**
         * Build next page URL
         * Trulia pattern: /NY/ → /NY/2_p/ → /NY/3_p/
         */
        function buildNextPageUrl(currentUrl, currentPage) {
            try {
                const url = new URL(currentUrl);
                const nextPage = currentPage + 1;

                // Remove existing page number if present
                let path = url.pathname.replace(/\/\d+_p\/?$/, '/');

                // Add new page number
                if (!path.endsWith('/')) path += '/';
                path += `${nextPage}_p/`;

                url.pathname = path;
                return url.href;
            } catch (e) {
                log.debug(`Error building next page URL: ${e.message}`);
                return null;
            }
        }

        const crawler = new CheerioCrawler({
            proxyConfiguration: proxyConf,
            maxRequestRetries: 5,
            maxConcurrency: 2,  // Very low for stealth (PerimeterX protection)
            requestHandlerTimeoutSecs: 60,

            // Session pool for rotation
            useSessionPool: true,
            sessionPoolOptions: {
                maxPoolSize: 50,
                sessionOptions: {
                    maxUsageCount: 5,  // Aggressive rotation due to PerimeterX
                    maxErrorScore: 3,
                },
            },

            // Stealth headers
            preNavigationHooks: [
                async ({ request }) => {
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
                        'accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
                        'accept-language': 'en-US,en;q=0.9',
                        'accept-encoding': 'gzip, deflate, br',
                        'cache-control': 'max-age=0',
                    };

                    // Faster initial delay (0.5-1.5 seconds) - still human-like
                    const delay = 500 + Math.random() * 1000;
                    await new Promise(resolve => setTimeout(resolve, delay));
                },
            ],

            async requestHandler({ request, $, enqueueLinks, session }) {
                const pageNo = request.userData?.pageNo || 1;
                log.info(`📄 Page ${pageNo}: ${request.url}`);

                // Check for blocking
                const title = $('title').text();
                if (title.includes('Access Denied') || title.includes('Captcha') || title.includes('Robot')) {
                    log.error(`🚫 BLOCKED on page ${pageNo}! Title: ${title}`);
                    session?.retire();
                    throw new Error('Blocked by anti-bot protection');
                }

                let listings = [];

                // PRIORITY 1: Extract from __NEXT_DATA__ (fastest, most complete)
                listings = extractFromNextData($);

                if (listings && listings.length > 0) {
                    log.info(`✅ Extracted ${listings.length} listings from __NEXT_DATA__`);
                } else {
                    // PRIORITY 2: Try JSON-LD fallback
                    listings = extractFromJsonLd($);
                    if (listings && listings.length > 0) {
                        log.info(`✅ Extracted ${listings.length} listings from JSON-LD`);
                    } else {
                        log.warning(`⚠️ No listings found on page ${pageNo}`);
                        // Save debug HTML for inspection
                        await Actor.setValue(`debug-page-${pageNo}`, $.html(), { contentType: 'text/html' });
                        listings = [];
                    }
                }

                // Deduplicate and save
                const newListings = [];
                for (const listing of listings) {
                    if (saved >= RESULTS_WANTED) break;

                    const key = listing.url || listing.full_address || listing.address;
                    if (key && !seenUrls.has(key)) {
                        seenUrls.add(key);
                        newListings.push(listing);
                        saved++;
                    }
                }

                if (newListings.length > 0) {
                    await Dataset.pushData(newListings);
                    log.info(`💾 Saved ${newListings.length} listings (total: ${saved}/${RESULTS_WANTED})`);
                }

                // Quick delay before pagination (0.5-1s)
                const browseTime = 500 + Math.random() * 500;
                await new Promise(resolve => setTimeout(resolve, browseTime));

                // Pagination - only if we need more results
                if (saved < RESULTS_WANTED && pageNo < MAX_PAGES) {
                    const nextUrl = buildNextPageUrl(request.url, pageNo);
                    if (nextUrl && !seenUrls.has(nextUrl)) {
                        seenUrls.add(nextUrl);
                        await enqueueLinks({
                            urls: [nextUrl],
                            userData: { pageNo: pageNo + 1 },
                        });
                        log.info(`➡️ Queued page ${pageNo + 1}: ${nextUrl}`);
                    }
                }
            },

            failedRequestHandler({ request }, error) {
                log.error(`❌ Failed: ${request.url} - ${error.message}`);
            },
        });

        log.info(`🏠 Starting Trulia Scraper`);
        log.info(`📍 URL: ${initialUrl}`);
        log.info(`🎯 Target: ${RESULTS_WANTED} listings, max ${MAX_PAGES} pages`);

        await crawler.run([{ url: initialUrl, userData: { pageNo: 1 } }]);

        log.info(`✅ Finished! Saved ${saved} listings.`);
    } finally {
        await Actor.exit();
    }
}

main().catch(err => {
    log.error(`Fatal error: ${err.message}`);
    process.exit(1);
});
