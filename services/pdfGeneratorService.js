/**
 * PDF Generator Service
 * Generates beautiful PDF documents from recipes using Puppeteer
 */

const puppeteer = require('puppeteer');

class PDFGeneratorService {
  constructor() {
    this.browser = null;
  }

  /**
   * Get or create a browser instance
   * Reuses browser for efficiency, creates new one if needed
   */
  async getBrowser() {
    if (!this.browser || !this.browser.isConnected()) {
      console.log('[PDFGenerator] Launching new browser instance...');
      this.browser = await puppeteer.launch({
        headless: 'new',
        args: [
          '--no-sandbox',
          '--disable-setuid-sandbox',
          '--disable-dev-shm-usage',
          '--disable-gpu'
        ]
      });
    }
    return this.browser;
  }

  /**
   * Generate a PDF from a recipe
   * @param {Object} recipe - Recipe data object
   * @returns {Buffer} PDF as buffer
   */
  async generateRecipePDF(recipe) {
    console.log(`[PDFGenerator] Generating PDF for: ${recipe.title || 'Untitled Recipe'}`);

    const html = this.renderTemplate(recipe);
    const browser = await this.getBrowser();
    const page = await browser.newPage();

    try {
      await page.setContent(html, {
        waitUntil: 'networkidle0',
        timeout: 30000
      });

      const pdf = await page.pdf({
        format: 'A4',
        margin: {
          top: '0.75in',
          right: '0.75in',
          bottom: '0.75in',
          left: '0.75in'
        },
        printBackground: true
      });

      console.log(`[PDFGenerator] PDF generated successfully (${pdf.length} bytes)`);
      return pdf;

    } finally {
      await page.close();
    }
  }

  /**
   * Render HTML template for the recipe
   * @param {Object} recipe - Recipe data
   * @returns {string} HTML string
   */
  renderTemplate(recipe) {
    const ingredients = recipe.extendedIngredients || [];
    const instructions = recipe.analyzedInstructions?.[0]?.steps || [];
    const nutrition = recipe.nutrition?.perServing || null;

    // Format dietary tags
    const dietaryTags = [];
    if (recipe.vegetarian) dietaryTags.push('Vegetarian');
    if (recipe.vegan) dietaryTags.push('Vegan');
    if (recipe.glutenFree) dietaryTags.push('Gluten-Free');
    if (recipe.dairyFree) dietaryTags.push('Dairy-Free');

    // Escape HTML to prevent XSS in PDF
    const escapeHtml = (str) => {
      if (!str) return '';
      return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#039;');
    };

    return `
    <!DOCTYPE html>
    <html>
    <head>
      <meta charset="utf-8">
      <style>
        * {
          box-sizing: border-box;
          margin: 0;
          padding: 0;
        }

        body {
          font-family: 'Georgia', 'Times New Roman', serif;
          max-width: 800px;
          margin: 0 auto;
          padding: 40px;
          color: #333;
          line-height: 1.6;
          background: #fff;
        }

        .header {
          border-bottom: 3px solid #4fcf61;
          padding-bottom: 20px;
          margin-bottom: 30px;
        }

        h1 {
          color: #2d3748;
          font-size: 28px;
          font-weight: 700;
          margin-bottom: 10px;
          line-height: 1.3;
        }

        .source {
          color: #718096;
          font-size: 14px;
          font-style: italic;
          margin-bottom: 15px;
        }

        .meta {
          display: flex;
          flex-wrap: wrap;
          gap: 20px;
          margin-bottom: 15px;
        }

        .meta-item {
          display: flex;
          align-items: center;
          gap: 6px;
          color: #4a5568;
          font-size: 14px;
        }

        .meta-item strong {
          color: #2d3748;
        }

        .dietary-tags {
          display: flex;
          flex-wrap: wrap;
          gap: 8px;
          margin-top: 10px;
        }

        .dietary-tag {
          background: #e6ffed;
          color: #22543d;
          padding: 4px 12px;
          border-radius: 20px;
          font-size: 12px;
          font-weight: 500;
        }

        .image-container {
          width: 100%;
          margin: 25px 0;
          border-radius: 12px;
          overflow: hidden;
          box-shadow: 0 4px 6px rgba(0, 0, 0, 0.1);
        }

        .recipe-image {
          width: 100%;
          max-height: 350px;
          object-fit: cover;
          display: block;
        }

        .summary {
          background: #f7fafc;
          padding: 20px;
          border-radius: 8px;
          margin: 25px 0;
          font-size: 15px;
          color: #4a5568;
          border-left: 4px solid #4fcf61;
        }

        h2 {
          color: #2d3748;
          font-size: 20px;
          margin: 30px 0 15px 0;
          padding-bottom: 8px;
          border-bottom: 2px solid #e2e8f0;
        }

        .ingredients-list {
          list-style: none;
          padding: 0;
        }

        .ingredients-list li {
          padding: 8px 0;
          border-bottom: 1px solid #edf2f7;
          font-size: 15px;
        }

        .ingredients-list li:last-child {
          border-bottom: none;
        }

        .ingredients-list li::before {
          content: "\\2022";
          color: #4fcf61;
          font-weight: bold;
          display: inline-block;
          width: 1em;
          margin-left: -1em;
          padding-left: 1em;
        }

        .instructions-list {
          list-style: none;
          padding: 0;
          counter-reset: step-counter;
        }

        .instructions-list li {
          padding: 15px 0 15px 45px;
          border-bottom: 1px solid #edf2f7;
          position: relative;
          font-size: 15px;
          line-height: 1.7;
        }

        .instructions-list li:last-child {
          border-bottom: none;
        }

        .instructions-list li::before {
          counter-increment: step-counter;
          content: counter(step-counter);
          position: absolute;
          left: 0;
          top: 15px;
          background: #4fcf61;
          color: white;
          width: 28px;
          height: 28px;
          border-radius: 50%;
          display: flex;
          align-items: center;
          justify-content: center;
          font-size: 14px;
          font-weight: 600;
        }

        .nutrition-grid {
          display: grid;
          grid-template-columns: repeat(3, 1fr);
          gap: 15px;
          margin-top: 15px;
        }

        .nutrition-item {
          background: #f7fafc;
          padding: 12px;
          border-radius: 8px;
          text-align: center;
        }

        .nutrition-value {
          font-size: 18px;
          font-weight: 700;
          color: #2d3748;
        }

        .nutrition-label {
          font-size: 12px;
          color: #718096;
          text-transform: uppercase;
          letter-spacing: 0.5px;
        }

        .footer {
          margin-top: 50px;
          padding-top: 20px;
          border-top: 2px solid #e2e8f0;
          text-align: center;
          color: #a0aec0;
          font-size: 12px;
        }

        .footer-logo {
          color: #4fcf61;
          font-weight: 700;
          font-size: 14px;
        }

        @media print {
          body {
            padding: 20px;
          }

          .instructions-list li {
            page-break-inside: avoid;
          }
        }
      </style>
    </head>
    <body>
      <div class="header">
        <h1>${escapeHtml(recipe.title || 'Untitled Recipe')}</h1>

        ${recipe.source_author ? `
          <div class="source">
            From: ${escapeHtml(recipe.source_author)}
          </div>
        ` : ''}

        <div class="meta">
          ${recipe.readyInMinutes ? `
            <div class="meta-item">
              <strong>Time:</strong> ${recipe.readyInMinutes} minutes
            </div>
          ` : ''}
          ${recipe.servings ? `
            <div class="meta-item">
              <strong>Servings:</strong> ${recipe.servings}
            </div>
          ` : ''}
          ${recipe.cuisines && recipe.cuisines.length > 0 ? `
            <div class="meta-item">
              <strong>Cuisine:</strong> ${escapeHtml(recipe.cuisines.join(', '))}
            </div>
          ` : ''}
        </div>

        ${dietaryTags.length > 0 ? `
          <div class="dietary-tags">
            ${dietaryTags.map(tag => `<span class="dietary-tag">${tag}</span>`).join('')}
          </div>
        ` : ''}
      </div>

      ${recipe.image ? `
        <div class="image-container">
          <img class="recipe-image" src="${escapeHtml(recipe.image)}" alt="${escapeHtml(recipe.title)}">
        </div>
      ` : ''}

      ${recipe.summary ? `
        <div class="summary">
          ${escapeHtml(recipe.summary)}
        </div>
      ` : ''}

      ${ingredients.length > 0 ? `
        <h2>Ingredients</h2>
        <ul class="ingredients-list">
          ${ingredients.map(ing => `
            <li>${escapeHtml(ing.original || ing.name || '')}</li>
          `).join('')}
        </ul>
      ` : ''}

      ${instructions.length > 0 ? `
        <h2>Instructions</h2>
        <ol class="instructions-list">
          ${instructions.map(step => `
            <li>${escapeHtml(step.step || '')}</li>
          `).join('')}
        </ol>
      ` : ''}

      ${nutrition ? `
        <h2>Nutrition (per serving)</h2>
        <div class="nutrition-grid">
          ${nutrition.calories ? `
            <div class="nutrition-item">
              <div class="nutrition-value">${Math.round(nutrition.calories)}</div>
              <div class="nutrition-label">Calories</div>
            </div>
          ` : ''}
          ${nutrition.protein ? `
            <div class="nutrition-item">
              <div class="nutrition-value">${Math.round(nutrition.protein)}g</div>
              <div class="nutrition-label">Protein</div>
            </div>
          ` : ''}
          ${nutrition.carbs ? `
            <div class="nutrition-item">
              <div class="nutrition-value">${Math.round(nutrition.carbs)}g</div>
              <div class="nutrition-label">Carbs</div>
            </div>
          ` : ''}
          ${nutrition.fat ? `
            <div class="nutrition-item">
              <div class="nutrition-value">${Math.round(nutrition.fat)}g</div>
              <div class="nutrition-label">Fat</div>
            </div>
          ` : ''}
          ${nutrition.fiber ? `
            <div class="nutrition-item">
              <div class="nutrition-value">${Math.round(nutrition.fiber)}g</div>
              <div class="nutrition-label">Fiber</div>
            </div>
          ` : ''}
          ${nutrition.sugar ? `
            <div class="nutrition-item">
              <div class="nutrition-value">${Math.round(nutrition.sugar)}g</div>
              <div class="nutrition-label">Sugar</div>
            </div>
          ` : ''}
        </div>
      ` : ''}

      <div class="footer">
        <div class="footer-logo">Trackabite</div>
        <div>Saved on ${new Date().toLocaleDateString('en-US', {
          year: 'numeric',
          month: 'long',
          day: 'numeric'
        })}</div>
      </div>
    </body>
    </html>
    `;
  }

  /**
   * Close the browser instance
   */
  async closeBrowser() {
    if (this.browser) {
      await this.browser.close();
      this.browser = null;
      console.log('[PDFGenerator] Browser closed');
    }
  }
}

module.exports = new PDFGeneratorService();
