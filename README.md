# MSI Product Scraper

A small Playwright script that opens one MSI US Store product page
(MAG Z890 TOMAHAWK WIFI), reads the data from the live page and saves it
as clean JSON in `output/product.json`.

## How to run

You need Node.js 20 or newer.

```bash
npm install
npx playwright install chromium
npm run scrape
```

After that, `output/product.json` is created (or overwritten).

### A note about headless mode

The task says headless, but the site (it sits behind Akamai) answers
**403 Access Denied** to headless Chromium. I tried the headless shell,
the new headless mode and a normal User-Agent, and all three got blocked.
I didn't want to go into stealth tricks to get around the protection,
so by default the script opens a normal visible browser window and
it works fine that way.

If you want to try headless anyway:

```bash
HEADLESS=true npm run scrape
```

On my machine this ends with a clean error message and exit code 1.

## Project layout

- `src/scrape.js`: the scraper itself.
- `src/explore.js`: the script I used to look at the page first (title,
  canonical, hidden inputs, JSON-LD) and to save the HTML locally for
  searching selectors. Run it with `npm run explore`. It is not needed
  for the scraper.
- `output/product.json`: the result of a real run.

## How it works

1. Open the page and wait until the price element shows up.
2. Read the raw text and attributes from the page.
3. Clean and convert them with small helper functions.
4. Write everything to `output/product.json`.

The helpers are in `src/scrape.js`: `cleanText`, `parsePrice`,
`normalizeAvailability`, `toAbsoluteUrl`, `extractBreadcrumbs`,
`extractImages`, `extractSpecs` and a couple of small ones.

## Decisions I made

- **Selectors are scoped to the main product block.** The page has a
  "Recommended for you" section full of other products with their own
  prices, so I never use something like `.price-new` on the whole page.
  The price comes from `#prices-new`, which exists exactly once.
- **Bundle prices are ignored.** Things like `(+$319.00)` in the bundle
  dropdown are add-ons, not the product price.
- **Description comes from the page content** (`#description-list`).
  The meta description is wrong, it talks about a different board.
- **`url` is `page.url()`**, not the canonical link, because they differ.
- **Images are deduplicated.** The same picture is on the page in 400x400
  and 1024x1024. I turn all of them into the 1024x1024 version and put
  them in a `Set`, then sort them by file number because the carousel
  shuffles the order in the DOM.
- **Breadcrumb** has no "Home" and no product name at the end, to match
  the example in the task. The product name is already in `title`.
  URLs for the categories are taken from the page.
- **Missing data is `null`, empty lists are `[]`.** I don't guess.
  `gtin` is `null` because there is no UPC/GTIN on the page.
  `sale_price` is `null` because there is no discount on this product.
- **Rating and review count** are read from the page (`4.7` and `3`).
- **Specs** are cleaned from extra line breaks and spaces.
  `mpn` is taken from the "Manufacturer Number" row.
- **`brand`** has no element on the page, so I take it from the page
  `<title>`: whatever stands before the product name ("MSI ...").

## Limitations

- It only works for this one page and this layout. If MSI changes
  the HTML, the selectors will need an update.
- Headless mode is blocked by the site (see above).
- No retries. If the page fails to load, the script just stops with an
  error and exit code 1.
- The output path is relative, so run it from the project root
  (`npm run scrape` does that).

## What I would improve

- Add retries with a short delay for flaky network.
- Support several products from a list of URLs.
- Use Cheerio for pages that are fully server-rendered. It is much faster
  because it doesn't need a browser at all.
- Add a few tests for the helper functions (`parsePrice`, `cleanText`...).
- Ask the site owners about proper access if this was a real project.
