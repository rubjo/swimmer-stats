import puppeteer from 'puppeteer';

const url = process.env.SCRAPE_URL || 'https://www.medley.no/Sv%C3%B8mmer.aspx';

(async () => {
  try {
    const browser = await puppeteer.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox'],
    });

    const page = await browser.newPage();
    await page.goto(url, { waitUntil: 'networkidle2', timeout: 60000 });

    console.log(`Loaded ${url}`);
    const title = await page.title();
    console.log('Page title:', title);

    // Placeholder for the real scraping logic. Keep this file minimal so the Action runs.
    // The full scraping implementation can be restored or expanded separately.

    await browser.close();
    process.exit(0);
  } catch (err) {
    console.error('Scrape failed:', err);
    process.exit(1);
  }
})();
