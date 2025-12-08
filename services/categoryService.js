const fetch = require('node-fetch');

// Keyword mapping for local categorization (fast, no API call)
const CATEGORY_KEYWORDS = {
  'Produce': [
    'apple', 'banana', 'lettuce', 'tomato', 'onion', 'garlic', 'carrot', 'broccoli',
    'spinach', 'avocado', 'lemon', 'lime', 'orange', 'grape', 'strawberry', 'blueberry',
    'potato', 'cucumber', 'pepper', 'celery', 'mushroom', 'ginger', 'cilantro', 'parsley',
    'basil', 'kale', 'zucchini', 'squash', 'cabbage', 'cauliflower', 'asparagus', 'corn',
    'pea', 'bean sprout', 'radish', 'beet', 'turnip', 'eggplant', 'artichoke', 'leek',
    'shallot', 'scallion', 'green onion', 'jalapeno', 'habanero', 'serrano', 'poblano',
    'bell pepper', 'fruit', 'vegetable', 'salad', 'greens', 'arugula', 'romaine',
    'iceberg', 'chard', 'collard', 'bokchoy', 'bok choy', 'watercress', 'endive',
    'fennel', 'kohlrabi', 'rutabaga', 'parsnip', 'yam', 'sweet potato', 'plantain',
    'mango', 'papaya', 'pineapple', 'kiwi', 'melon', 'watermelon', 'cantaloupe',
    'honeydew', 'peach', 'plum', 'nectarine', 'apricot', 'cherry', 'raspberry',
    'blackberry', 'cranberry', 'pomegranate', 'fig', 'date', 'coconut', 'dragonfruit',
    'passion fruit', 'guava', 'lychee', 'persimmon', 'pear', 'grapefruit', 'tangerine',
    'clementine', 'mandarin', 'blood orange', 'kumquat', 'starfruit', 'jackfruit'
  ],
  'Dairy & Eggs': [
    'milk', 'cheese', 'butter', 'yogurt', 'cream', 'egg', 'cottage', 'sour cream',
    'half and half', 'cream cheese', 'mozzarella', 'cheddar', 'parmesan', 'feta',
    'goat cheese', 'brie', 'ricotta', 'whipping cream', 'heavy cream', 'oat milk',
    'almond milk', 'soy milk', 'coconut milk', 'lactose', 'swiss', 'provolone',
    'gruyere', 'gouda', 'havarti', 'muenster', 'colby', 'monterey jack', 'pepper jack',
    'blue cheese', 'gorgonzola', 'mascarpone', 'neufchatel', 'queso', 'paneer',
    'halloumi', 'burrata', 'fresh mozzarella', 'string cheese', 'american cheese',
    'velveeta', 'laughing cow', 'babybel', 'kefir', 'greek yogurt', 'skyr',
    'buttermilk', 'evaporated milk', 'condensed milk', 'cashew milk', 'rice milk',
    'hemp milk', 'flax milk', 'pea milk', 'oatly', 'silk', 'dairy'
  ],
  'Meat & Seafood': [
    'chicken', 'beef', 'pork', 'turkey', 'fish', 'salmon', 'shrimp', 'bacon',
    'sausage', 'ground beef', 'steak', 'ham', 'lamb', 'tuna', 'crab', 'lobster',
    'tilapia', 'cod', 'halibut', 'trout', 'mahi', 'scallop', 'mussel', 'clam',
    'oyster', 'duck', 'veal', 'bison', 'venison', 'prosciutto', 'pepperoni',
    'salami', 'deli', 'hot dog', 'bratwurst', 'chorizo', 'meatball', 'patty',
    'wing', 'thigh', 'breast', 'drumstick', 'ribs', 'roast', 'filet', 'tenderloin',
    'sirloin', 'ribeye', 'flank', 'brisket', 'chuck', 'ground turkey', 'ground pork',
    'ground chicken', 'italian sausage', 'breakfast sausage', 'kielbasa', 'andouille',
    'mortadella', 'capicola', 'pancetta', 'guanciale', 'lardons', 'spam',
    'corned beef', 'pastrami', 'roast beef', 'turkey breast', 'chicken breast',
    'pork chop', 'pork loin', 'pork shoulder', 'pulled pork', 'carnitas',
    'carne asada', 'fajita', 'ceviche', 'sashimi', 'calamari', 'squid', 'octopus',
    'anchovy', 'sardine', 'mackerel', 'sea bass', 'snapper', 'grouper', 'swordfish',
    'catfish', 'perch', 'walleye', 'pike', 'crawfish', 'crayfish', 'langostino',
    'meat', 'seafood', 'poultry', 'protein'
  ],
  'Bakery & Bread': [
    'bread', 'bagel', 'roll', 'bun', 'croissant', 'muffin', 'tortilla', 'pita',
    'baguette', 'english muffin', 'naan', 'flatbread', 'ciabatta', 'sourdough',
    'rye', 'pumpernickel', 'focaccia', 'brioche', 'challah', 'cake', 'pie',
    'donut', 'danish', 'pastry', 'scone', 'biscuit', 'cornbread', 'crumpet',
    'pretzel', 'breadstick', 'crouton', 'panini', 'hoagie', 'sub roll',
    'hamburger bun', 'hot dog bun', 'slider bun', 'kaiser roll', 'dinner roll',
    'french bread', 'italian bread', 'wheat bread', 'white bread', 'multigrain',
    'whole grain', 'gluten free bread', 'lavash', 'roti', 'chapati', 'paratha',
    'injera', 'arepa', 'pupusa', 'gordita', 'sope', 'tostada', 'taco shell',
    'corn tortilla', 'flour tortilla', 'wrap', 'phyllo', 'puff pastry',
    'pie crust', 'pizza dough', 'cinnamon roll', 'sticky bun', 'bear claw',
    'eclair', 'cream puff', 'profiterole', 'palmier', 'kouign amann',
    'pain au chocolat', 'almond croissant', 'fruit tart', 'cupcake', 'brownie',
    'blondie', 'cookie', 'macaron', 'macaroon', 'biscotti', 'shortbread'
  ],
  'Frozen Foods': [
    'frozen', 'ice cream', 'frozen pizza', 'frozen vegetables', 'frozen fruit',
    'popsicle', 'frozen dinner', 'frozen fish', 'frozen chicken', 'frozen shrimp',
    'frozen burrito', 'frozen waffle', 'frozen breakfast', 'ice pop', 'sorbet',
    'gelato', 'frozen yogurt', 'tv dinner', 'hot pocket', 'frozen entree',
    'frozen meal', 'lean cuisine', 'stouffer', 'marie callender', 'hungry man',
    'totino', 'bagel bite', 'pizza roll', 'egg roll', 'spring roll',
    'frozen dumpling', 'frozen potsticker', 'frozen pierogi', 'frozen ravioli',
    'frozen lasagna', 'frozen mac and cheese', 'frozen burrito', 'frozen taquito',
    'frozen corn dog', 'frozen mozzarella stick', 'frozen onion ring',
    'frozen french fry', 'frozen tater tot', 'frozen hash brown',
    'frozen pie', 'frozen cake', 'frozen cheesecake', 'frozen cookie dough',
    'ice', 'popsicle', 'fudge bar', 'ice cream sandwich', 'drumstick',
    'klondike', 'haagen dazs', 'ben and jerry', 'talenti', 'halo top'
  ],
  'Pantry & Canned Goods': [
    'rice', 'pasta', 'lentil', 'flour', 'sugar', 'oil', 'vinegar', 'canned',
    'soup', 'broth', 'stock', 'cereal', 'oatmeal', 'quinoa', 'couscous', 'nut',
    'almond', 'peanut butter', 'honey', 'maple syrup', 'noodle', 'spaghetti',
    'macaroni', 'penne', 'fettuccine', 'lasagna', 'ramen', 'udon', 'orzo',
    'chickpea', 'black bean', 'kidney bean', 'pinto bean', 'navy bean',
    'cannellini', 'dried', 'grain', 'barley', 'farro', 'bulgur', 'bread crumb',
    'panko', 'cornstarch', 'baking soda', 'baking powder', 'yeast', 'extract',
    'vanilla', 'cocoa', 'chocolate chip', 'brown sugar', 'powdered sugar',
    'molasses', 'agave', 'olive oil', 'vegetable oil', 'coconut oil',
    'sesame oil', 'cooking spray', 'tomato paste', 'tomato sauce', 'diced tomato',
    'crushed tomato', 'san marzano', 'rotel', 'enchilada sauce', 'green chili',
    'coconut cream', 'evaporated milk', 'sweetened condensed', 'pumpkin puree',
    'apple sauce', 'cranberry sauce', 'pie filling', 'mandarin orange',
    'pineapple chunk', 'fruit cocktail', 'peach', 'pear', 'cherry',
    'tuna can', 'salmon can', 'sardine can', 'anchovy', 'spam', 'corned beef hash',
    'chicken breast can', 'chili', 'baked beans', 'refried beans',
    'corn', 'green bean', 'pea', 'carrot', 'mixed vegetable', 'artichoke heart',
    'heart of palm', 'bamboo shoot', 'water chestnut', 'baby corn',
    'almond butter', 'cashew butter', 'sunflower butter', 'tahini',
    'nutella', 'cookie butter', 'jam', 'jelly', 'preserves', 'marmalade'
  ],
  'Snacks & Beverages': [
    'chips', 'crackers', 'cookies', 'soda', 'juice', 'water', 'coffee', 'tea',
    'beer', 'wine', 'snack', 'popcorn', 'pretzel', 'chocolate', 'candy',
    'energy drink', 'sparkling', 'cola', 'sprite', 'fanta', 'gatorade',
    'powerade', 'redbull', 'monster', 'lacroix', 'topo chico', 'granola bar',
    'protein bar', 'trail mix', 'nuts', 'dried fruit', 'jerky', 'goldfish',
    'cheez-it', 'oreo', 'chips ahoy', 'gummy', 'licorice', 'm&m', 'skittles',
    'twizzler', 'lays', 'doritos', 'cheetos', 'fritos', 'tostitos', 'ruffles',
    'pringles', 'sun chips', 'kettle chips', 'terra chips', 'veggie straws',
    'rice cake', 'rice crispy', 'fruit snack', 'fruit leather', 'fruit roll',
    'ritz', 'triscuit', 'wheat thin', 'club cracker', 'saltine', 'graham cracker',
    'animal cracker', 'teddy graham', 'nilla wafer', 'fig newton',
    'pepsi', 'coke', 'coca cola', 'dr pepper', 'mountain dew', 'root beer',
    '7up', 'sierra mist', 'ginger ale', 'tonic water', 'club soda',
    'lemonade', 'iced tea', 'arnold palmer', 'vitamin water', 'body armor',
    'prime', 'celsius', 'bang', 'reign', 'rockstar', 'nos', 'full throttle',
    'starbucks', 'dunkin', 'cold brew', 'nitro coffee', 'frappuccino',
    'kombucha', 'coconut water', 'aloe vera drink', 'boba', 'bubble tea',
    'arizona', 'snapple', 'honest tea', 'pure leaf', 'gold peak',
    'liquor', 'vodka', 'whiskey', 'rum', 'tequila', 'gin', 'brandy',
    'bourbon', 'scotch', 'cognac', 'champagne', 'prosecco', 'cava',
    'hard seltzer', 'white claw', 'truly', 'high noon', 'mike hard',
    'smirnoff ice', 'twisted tea', 'seagrams', 'four loko', 'natty light',
    'bud light', 'coors light', 'miller lite', 'corona', 'modelo', 'heineken',
    'stella artois', 'guinness', 'blue moon', 'sam adams', 'sierra nevada',
    'lagunitas', 'stone', 'dogfish', 'bells', 'founders', 'goose island'
  ],
  'Condiments & Sauces': [
    'ketchup', 'mustard', 'mayo', 'mayonnaise', 'sauce', 'salsa', 'dressing',
    'soy sauce', 'hot sauce', 'bbq sauce', 'sriracha', 'worcestershire',
    'teriyaki', 'marinade', 'jam', 'jelly', 'relish', 'pickle', 'olive',
    'caper', 'horseradish', 'wasabi', 'hummus', 'guacamole', 'tahini',
    'tzatziki', 'aioli', 'pesto', 'alfredo', 'marinara', 'tomato sauce',
    'enchilada sauce', 'curry paste', 'miso', 'fish sauce', 'oyster sauce',
    'hoisin', 'chutney', 'preserves', 'marmalade', 'nutella', 'syrup',
    'frank red hot', 'tabasco', 'cholula', 'valentina', 'tapatio', 'crystal',
    'louisiana', 'texas pete', 'sambal', 'gochujang', 'harissa', 'zhug',
    'chimichurri', 'romesco', 'muhammara', 'baba ganoush', 'tapenade',
    'olive oil', 'balsamic', 'red wine vinegar', 'white wine vinegar',
    'apple cider vinegar', 'rice vinegar', 'sherry vinegar', 'champagne vinegar',
    'ranch', 'blue cheese dressing', 'caesar', 'italian dressing', 'greek dressing',
    'thousand island', 'honey mustard', 'french dressing', 'catalina',
    'balsamic vinaigrette', 'raspberry vinaigrette', 'asian dressing',
    'sesame ginger', 'miso dressing', 'green goddess', 'goddess dressing',
    'dijon', 'yellow mustard', 'spicy mustard', 'whole grain mustard',
    'honey', 'agave', 'maple syrup', 'pancake syrup', 'chocolate syrup',
    'caramel sauce', 'butterscotch', 'dulce de leche', 'marshmallow fluff',
    'whipped cream', 'cool whip', 'reddi wip', 'spray cream'
  ]
};

const categoryService = {
  /**
   * Categorize a single item using local keyword matching
   * @param {string} itemName - The name of the grocery item
   * @returns {string|null} The category or null if no match found
   */
  categorizeItem(itemName) {
    if (!itemName) return null;

    const normalizedName = itemName.toLowerCase().trim();

    // Try local categorization first
    for (const [category, keywords] of Object.entries(CATEGORY_KEYWORDS)) {
      for (const keyword of keywords) {
        if (normalizedName.includes(keyword)) {
          return category;
        }
      }
    }

    return null; // No match found
  },

  /**
   * Batch categorize items using AI for items that couldn't be matched locally
   * @param {string[]} itemNames - Array of item names to categorize
   * @returns {Promise<Object>} Object mapping item names to categories
   */
  async categorizeBatchWithAI(itemNames) {
    if (!itemNames || itemNames.length === 0) {
      return {};
    }

    try {
      console.log('[CategoryService] AI categorizing items:', itemNames);

      const prompt = `Categorize these grocery items into ONE of these exact categories:
- Produce
- Dairy & Eggs
- Meat & Seafood
- Bakery & Bread
- Frozen Foods
- Pantry & Canned Goods
- Snacks & Beverages
- Condiments & Sauces
- Other

Items to categorize:
${itemNames.map((name, i) => `${i + 1}. ${name}`).join('\n')}

Return ONLY a JSON object mapping item names to categories, like:
{"item name": "Category", "another item": "Category"}`;

      const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${process.env.OPENROUTER_API_KEY}`,
          'HTTP-Referer': 'https://fridgy.app',
          'X-Title': 'Fridgy Category Service'
        },
        body: JSON.stringify({
          model: 'google/gemini-2.0-flash-001',
          messages: [{ role: 'user', content: prompt }],
          temperature: 0.1,
          max_tokens: 500
        })
      });

      if (!response.ok) {
        console.error('[CategoryService] AI API error:', response.status);
        return {};
      }

      const data = await response.json();
      const content = data.choices?.[0]?.message?.content;

      // Parse JSON from response
      const jsonMatch = content.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        const parsed = JSON.parse(jsonMatch[0]);
        console.log('[CategoryService] AI categorization result:', parsed);
        return parsed;
      }

      return {};
    } catch (error) {
      console.error('[CategoryService] AI categorization error:', error);
      return {};
    }
  },

  /**
   * Smart categorization: local first, then batch AI for unknowns
   * @param {string[]} itemNames - Array of item names to categorize
   * @returns {Promise<Object>} Object mapping item names to categories
   */
  async categorizeItems(itemNames) {
    const results = {};
    const needsAI = [];

    // First pass: local categorization
    for (const name of itemNames) {
      const category = this.categorizeItem(name);
      if (category) {
        results[name] = category;
      } else {
        needsAI.push(name);
      }
    }

    console.log(`[CategoryService] Local categorization: ${Object.keys(results).length} matched, ${needsAI.length} need AI`);

    // Second pass: AI for unknowns (batched)
    if (needsAI.length > 0 && process.env.OPENROUTER_API_KEY) {
      const aiResults = await this.categorizeBatchWithAI(needsAI);
      Object.assign(results, aiResults);
    }

    // Fill in remaining with 'Other'
    for (const name of itemNames) {
      if (!results[name]) {
        results[name] = 'Other';
      }
    }

    return results;
  }
};

module.exports = categoryService;
