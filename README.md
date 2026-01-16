# Trulia Real Estate Scraper

Extract comprehensive real estate listings from Trulia.com. Get property details including prices, bedroom/bathroom counts, square footage, lot sizes, addresses, and listing information for homes across the United States.

---

## Features

- **For Sale & Rental Listings** - Scrape homes for sale or rental properties
- **Complete Property Data** - Price, beds, baths, sqft, lot size, and full address
- **High Volume** - Collect up to hundreds of listings per run
- **Location-Based Search** - Search by state code or city name
- **Image URLs** - Get property listing images
- **Listing Attribution** - See which broker or agent listed each property

---

## Use Cases

- **Real Estate Market Research** - Analyze property prices across different neighborhoods
- **Investment Analysis** - Find undervalued properties or emerging markets
- **Competitor Monitoring** - Track new listings from specific brokers
- **Price Trend Analysis** - Monitor how home prices change over time
- **Lead Generation** - Build lists of properties for real estate businesses
- **Data Aggregation** - Combine Trulia data with other real estate sources

---

## Input Parameters

| Parameter | Type | Description |
|-----------|------|-------------|
| `start_url` | String | Direct Trulia search URL (optional) |
| `location` | String | State code or city (e.g., "NY", "Los Angeles") |
| `listing_type` | String | "buy" for sale or "rent" for rentals |
| `results_wanted` | Integer | Maximum listings to collect (default: 20) |
| `max_pages` | Integer | Maximum pages to scrape (default: 5) |
| `proxyConfiguration` | Object | Proxy settings for reliable access |

---

## Output Data

Each listing includes these fields:

| Field | Description |
|-------|-------------|
| `price` | Listed price (e.g., "$689,000") |
| `beds` | Number of bedrooms |
| `baths` | Number of bathrooms |
| `sqft` | Square footage |
| `lot_size` | Lot size in acres |
| `address` | Street address |
| `city` | City name |
| `state` | State code |
| `zip_code` | ZIP code |
| `property_type` | Type (new construction, buildable, etc.) |
| `listing_by` | Listing broker/agent |
| `image_url` | Property photo URL |
| `url` | Full Trulia listing URL |

---

## Usage Examples

**Search New York for sale:**

```json
{
  "location": "NY",
  "listing_type": "buy",
  "results_wanted": 50
}
```

**Search Los Angeles rentals:**

```json
{
  "location": "Los Angeles",
  "listing_type": "rent",
  "results_wanted": 100
}
```

**Use direct URL:**

```json
{
  "start_url": "https://www.trulia.com/CA/San_Francisco/",
  "results_wanted": 30
}
```

---

## Sample Output

```json
{
  "price": "$689,000+",
  "beds": "3",
  "baths": "2",
  "sqft": "2082",
  "lot_size": "0.91 acres",
  "address": "1208 State Route 31",
  "city": "Bridgeport",
  "state": "NY",
  "zip_code": "13030",
  "property_type": "NEW CONSTRUCTION",
  "listing_by": "ESSEX HOMES",
  "image_url": "https://www.trulia.com/pictures/thumbs/...",
  "url": "https://www.trulia.com/p/ny/bridgeport/1208-state-route-31-..."
}
```

---

## Tips

- **Start small** - Begin with `results_wanted: 20` to test, then scale up
- **Use proxies** - Residential proxies are recommended for reliable access
- **Target specific areas** - Use direct URLs for precise neighborhood targeting
- **Monitor pricing** - Run scrapes daily or weekly for price trend data
- **Respect limits** - Keep `max_pages` reasonable to avoid rate limits

---

## Integrations

This scraper works seamlessly with the Apify platform:

- **Apify Datasets** - Export to JSON, CSV, or Excel
- **Webhooks** - Trigger actions when new data is available
- **Scheduling** - Run automatically on a schedule
- **API Access** - Integrate with your own applications
- **Google Sheets** - Export directly to spreadsheets
- **Slack/Email** - Get notifications when runs complete

---

## FAQ

**How many listings can I scrape?**
You can scrape hundreds of listings per run. Use `results_wanted` and `max_pages` to control the volume.

**Do I need proxies?**
Yes, residential proxies are recommended for reliable access to Trulia.

**Can I search specific neighborhoods?**
Yes, use the `start_url` parameter with a direct Trulia search URL for precise targeting.

**How often is data updated?**
Data is extracted in real-time from Trulia. Run the scraper as needed for fresh data.

**What locations are supported?**
All US states and cities available on Trulia.com.

---

## Legal Notice

This scraper is intended for personal and educational use. Ensure your use complies with Trulia's Terms of Service and applicable laws. Scrape responsibly and respect rate limits.