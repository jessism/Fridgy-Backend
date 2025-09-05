/**
 * Script to generate placeholder PNG images from existing Icons8 SVG files
 * This can be used as a fallback when real images are not available
 */

const fs = require('fs');
const path = require('path');

// Configuration
const PLACEHOLDER_CONFIG = {
  width: 500,
  height: 500,
  backgroundColor: '#ffffff',
  padding: 50
};

/**
 * Instructions for generating PNG placeholders from Icons8 SVGs
 * 
 * Since direct SVG to PNG conversion requires additional dependencies,
 * here are the recommended approaches:
 * 
 * Option 1: Use online converters
 * - CloudConvert (https://cloudconvert.com/svg-to-png)
 * - Convertio (https://convertio.co/svg-png/)
 * - SVGtoPNG.com (https://svgtopng.com/)
 * 
 * Option 2: Use a Node.js library (requires installation)
 * - npm install sharp
 * - npm install svg2img
 * - npm install puppeteer (for high-quality conversion)
 * 
 * Option 3: Use ImageMagick (command line)
 * - convert -background white -size 500x500 input.svg output.png
 * 
 * Option 4: Use free stock photo APIs programmatically
 */

// Example implementation using Unsplash API
const generateRealFoodImages = {
  /**
   * Fetch real food images from Unsplash API
   * Note: Requires Unsplash API key (free tier available)
   */
  async fetchFromUnsplash(ingredientName, apiKey) {
    const baseUrl = 'https://api.unsplash.com/search/photos';
    const params = new URLSearchParams({
      query: `${ingredientName} isolated white background`,
      per_page: 1,
      orientation: 'squarish'
    });

    try {
      const response = await fetch(`${baseUrl}?${params}`, {
        headers: {
          'Authorization': `Client-ID ${apiKey}`
        }
      });
      
      const data = await response.json();
      if (data.results && data.results.length > 0) {
        return {
          url: data.results[0].urls.regular,
          thumbnailUrl: data.results[0].urls.small,
          photographer: data.results[0].user.name,
          source: 'unsplash'
        };
      }
    } catch (error) {
      console.error(`Error fetching image for ${ingredientName}:`, error);
    }
    return null;
  },

  /**
   * Fetch from Pexels API (also free)
   */
  async fetchFromPexels(ingredientName, apiKey) {
    const baseUrl = 'https://api.pexels.com/v1/search';
    const params = new URLSearchParams({
      query: `${ingredientName} food isolated`,
      per_page: 1,
      orientation: 'square'
    });

    try {
      const response = await fetch(`${baseUrl}?${params}`, {
        headers: {
          'Authorization': apiKey
        }
      });
      
      const data = await response.json();
      if (data.photos && data.photos.length > 0) {
        return {
          url: data.photos[0].src.large,
          thumbnailUrl: data.photos[0].src.medium,
          photographer: data.photos[0].photographer,
          source: 'pexels'
        };
      }
    } catch (error) {
      console.error(`Error fetching image for ${ingredientName}:`, error);
    }
    return null;
  },

  /**
   * Generate a SQL insert statement for ingredient images
   */
  generateSQL(ingredientData) {
    const { name, category, imageUrl, thumbnailUrl, aliases = [], tags = [] } = ingredientData;
    
    return `INSERT INTO ingredient_images (ingredient_name, display_name, category, image_url, thumbnail_url, aliases, tags, priority, source)
VALUES ('${name}', '${name}', '${category}', '${imageUrl}', '${thumbnailUrl}', '${JSON.stringify(aliases)}'::jsonb, '${JSON.stringify(tags)}'::jsonb, 50, 'api')
ON CONFLICT (ingredient_name, category) DO UPDATE SET
  image_url = EXCLUDED.image_url,
  thumbnail_url = EXCLUDED.thumbnail_url,
  updated_at = NOW();`;
  }
};

// List of common ingredients to generate images for
const COMMON_INGREDIENTS = [
  { name: 'Apple', category: 'Fruits', aliases: ['apples', 'red apple', 'green apple'] },
  { name: 'Banana', category: 'Fruits', aliases: ['bananas', 'plantain'] },
  { name: 'Carrot', category: 'Vegetables', aliases: ['carrots', 'baby carrots'] },
  { name: 'Tomato', category: 'Vegetables', aliases: ['tomatoes', 'roma tomato'] },
  { name: 'Milk', category: 'Dairy', aliases: ['whole milk', '2% milk'] },
  { name: 'Cheese', category: 'Dairy', aliases: ['cheddar', 'swiss', 'mozzarella'] },
  { name: 'Chicken', category: 'Protein', aliases: ['chicken breast', 'chicken thigh'] },
  { name: 'Egg', category: 'Protein', aliases: ['eggs', 'dozen eggs'] },
  { name: 'Rice', category: 'Grains', aliases: ['white rice', 'brown rice'] },
  { name: 'Bread', category: 'Grains', aliases: ['loaf', 'sliced bread'] }
];

// Main function to generate image database
async function generateImageDatabase() {
  console.log('🖼️  Generating Real Food Image Database');
  console.log('=====================================\n');
  
  // Check for API keys in environment
  const unsplashKey = process.env.UNSPLASH_API_KEY;
  const pexelsKey = process.env.PEXELS_API_KEY;
  
  if (!unsplashKey && !pexelsKey) {
    console.log('❌ No API keys found. Please set UNSPLASH_API_KEY or PEXELS_API_KEY');
    console.log('\n📝 To get free API keys:');
    console.log('   - Unsplash: https://unsplash.com/developers');
    console.log('   - Pexels: https://www.pexels.com/api/');
    console.log('\n🔧 Set environment variables:');
    console.log('   export UNSPLASH_API_KEY="your-key-here"');
    console.log('   export PEXELS_API_KEY="your-key-here"');
    return;
  }
  
  const sqlStatements = [];
  
  for (const ingredient of COMMON_INGREDIENTS) {
    console.log(`\n📸 Fetching image for ${ingredient.name}...`);
    
    let imageData = null;
    
    // Try Unsplash first
    if (unsplashKey) {
      imageData = await generateRealFoodImages.fetchFromUnsplash(ingredient.name, unsplashKey);
    }
    
    // Fall back to Pexels
    if (!imageData && pexelsKey) {
      imageData = await generateRealFoodImages.fetchFromPexels(ingredient.name, pexelsKey);
    }
    
    if (imageData) {
      console.log(`✅ Found image from ${imageData.source}`);
      const sql = generateRealFoodImages.generateSQL({
        name: ingredient.name,
        category: ingredient.category,
        imageUrl: imageData.url,
        thumbnailUrl: imageData.thumbnailUrl,
        aliases: ingredient.aliases,
        tags: []
      });
      sqlStatements.push(sql);
    } else {
      console.log(`⚠️  No image found for ${ingredient.name}`);
    }
  }
  
  // Save SQL statements to file
  if (sqlStatements.length > 0) {
    const outputPath = path.join(__dirname, '..', 'migrations', '010_generated_ingredient_images.sql');
    const sqlContent = `-- Auto-generated ingredient images from APIs
-- Generated on ${new Date().toISOString()}

${sqlStatements.join('\n\n')}
`;
    
    fs.writeFileSync(outputPath, sqlContent);
    console.log(`\n✅ Generated SQL file: ${outputPath}`);
    console.log(`   Total images: ${sqlStatements.length}`);
  }
}

// Export for use in other scripts
module.exports = {
  generateRealFoodImages,
  COMMON_INGREDIENTS,
  generateImageDatabase
};

// Run if called directly
if (require.main === module) {
  generateImageDatabase().catch(console.error);
}