/**
 * Recipe Tag Generation Service
 * Automatically generates 1-3 relevant tags for recipes based on:
 * - Dietary flags (vegetarian, vegan, gluten-free, dairy-free)
 * - Cook time (quick recipes < 30 min)
 * - Nutrition breakdown (keto, high protein, low carb)
 * - Ingredients (protein types, plant-based)
 * - Title/description keywords (cuisine types, meal types)
 */

const PREDEFINED_TAGS = [
  // Dietary (8 tags)
  { id: 'tag_vegetarian', name: 'Vegetarian', category: 'dietary', is_custom: false },
  { id: 'tag_vegan', name: 'Vegan', category: 'dietary', is_custom: false },
  { id: 'tag_keto', name: 'Keto', category: 'dietary', is_custom: false },
  { id: 'tag_paleo', name: 'Paleo', category: 'dietary', is_custom: false },
  { id: 'tag_gluten_free', name: 'Gluten-Free', category: 'dietary', is_custom: false },
  { id: 'tag_dairy_free', name: 'Dairy-Free', category: 'dietary', is_custom: false },
  { id: 'tag_low_carb', name: 'Low Carb', category: 'dietary', is_custom: false },
  { id: 'tag_high_protein', name: 'High Protein', category: 'dietary', is_custom: false },

  // Meal Type (6 tags)
  { id: 'tag_breakfast', name: 'Breakfast', category: 'meal_type', is_custom: false },
  { id: 'tag_lunch', name: 'Lunch', category: 'meal_type', is_custom: false },
  { id: 'tag_dinner', name: 'Dinner', category: 'meal_type', is_custom: false },
  { id: 'tag_snack', name: 'Snack', category: 'meal_type', is_custom: false },
  { id: 'tag_dessert', name: 'Dessert', category: 'meal_type', is_custom: false },
  { id: 'tag_appetizer', name: 'Appetizer', category: 'meal_type', is_custom: false },

  // Speed (2 tags)
  { id: 'tag_quick', name: 'Quick', category: 'speed', is_custom: false },
  { id: 'tag_easy', name: 'Easy', category: 'speed', is_custom: false },

  // Protein (5 tags)
  { id: 'tag_chicken', name: 'Chicken', category: 'protein', is_custom: false },
  { id: 'tag_beef', name: 'Beef', category: 'protein', is_custom: false },
  { id: 'tag_seafood', name: 'Seafood', category: 'protein', is_custom: false },
  { id: 'tag_pork', name: 'Pork', category: 'protein', is_custom: false },
  { id: 'tag_plant_based', name: 'Plant-Based', category: 'protein', is_custom: false },

  // Cuisine (8 tags)
  { id: 'tag_italian', name: 'Italian', category: 'cuisine', is_custom: false },
  { id: 'tag_mexican', name: 'Mexican', category: 'cuisine', is_custom: false },
  { id: 'tag_asian', name: 'Asian', category: 'cuisine', is_custom: false },
  { id: 'tag_mediterranean', name: 'Mediterranean', category: 'cuisine', is_custom: false },
  { id: 'tag_american', name: 'American', category: 'cuisine', is_custom: false },
  { id: 'tag_indian', name: 'Indian', category: 'cuisine', is_custom: false },
  { id: 'tag_french', name: 'French', category: 'cuisine', is_custom: false },
  { id: 'tag_thai', name: 'Thai', category: 'cuisine', is_custom: false },

  // Occasion (5 tags)
  { id: 'tag_weeknight', name: 'Weeknight', category: 'occasion', is_custom: false },
  { id: 'tag_weekend', name: 'Weekend', category: 'occasion', is_custom: false },
  { id: 'tag_meal_prep', name: 'Meal Prep', category: 'occasion', is_custom: false },
  { id: 'tag_party', name: 'Party', category: 'occasion', is_custom: false },
  { id: 'tag_holiday', name: 'Holiday', category: 'occasion', is_custom: false },
];

/**
 * Generate AI tags for a recipe based on its properties
 * @param {Object} recipe - Recipe object with ingredients, nutrition, time, etc.
 * @returns {Array} Array of up to 3 tag objects
 */
function generateRecipeTags(recipe) {
  const tags = [];
  const {
    extendedIngredients = [],
    readyInMinutes,
    nutrition,
    vegetarian,
    vegan,
    glutenFree,
    dairyFree,
    title = '',
    summary = '',
  } = recipe;

  // Helper to find tag by ID
  const findTag = (id) => PREDEFINED_TAGS.find(t => t.id === id);

  // === PRIORITY 1: Dietary Tags (from existing boolean flags) ===
  if (vegan) {
    tags.push(findTag('tag_vegan'));
    tags.push(findTag('tag_vegetarian')); // Vegan implies vegetarian
  } else if (vegetarian) {
    tags.push(findTag('tag_vegetarian'));
  }

  if (glutenFree) tags.push(findTag('tag_gluten_free'));
  if (dairyFree) tags.push(findTag('tag_dairy_free'));

  // === PRIORITY 2: Speed Tags (from cook time) ===
  if (readyInMinutes && readyInMinutes < 30) {
    tags.push(findTag('tag_quick'));
  }

  // === PRIORITY 3: Nutrition-Based Tags ===
  if (nutrition?.caloricBreakdown) {
    const { percentProtein, percentCarbs, percentFat } = nutrition.caloricBreakdown;

    // High Protein: ≥30% protein
    if (percentProtein >= 30) {
      tags.push(findTag('tag_high_protein'));
    }

    // Keto: ≥60% fat, <10% carbs
    if (percentFat >= 60 && percentCarbs < 10) {
      tags.push(findTag('tag_keto'));
    }

    // Low Carb: <20% carbs (but not keto)
    if (percentCarbs < 20 && !(percentFat >= 60 && percentCarbs < 10)) {
      tags.push(findTag('tag_low_carb'));
    }
  }

  // === PRIORITY 4: Protein Type (from ingredients) ===
  // Common non-protein derivatives to exclude from protein tag detection
  const NON_PROTEIN_KEYWORDS = [
    'bouillon', 'broth', 'stock', 'powder', 'cube', 'base', 'concentrate',
    'seasoning', 'flavoring', 'extract', 'essence'
  ];

  /**
   * Check if an ingredient is a protein derivative (bouillon, broth, stock)
   * rather than actual protein
   * @param {string} ingredientName - Lowercase ingredient name
   * @returns {boolean} True if it's a derivative, not actual protein
   */
  const isProteinDerivative = (ingredientName) => {
    return NON_PROTEIN_KEYWORDS.some(keyword =>
      ingredientName.includes(keyword)
    );
  };

  const ingredientText = extendedIngredients
    .map(ing => (ing.name || ing.original || '').toLowerCase())
    .join(' ');

  // Process each ingredient individually to avoid false positives
  const hasChicken = extendedIngredients.some(ing => {
    const name = (ing.name || ing.original || '').toLowerCase();
    return /\b(chicken|turkey|poultry)\b/.test(name) && !isProteinDerivative(name);
  });

  // BEEF CAVEAT: Include beef even if it's just broth/stock, as some people
  // have dietary restrictions that prevent them from consuming beef derivatives
  const hasBeef = extendedIngredients.some(ing => {
    const name = (ing.name || ing.original || '').toLowerCase();
    return /\b(beef|steak|ground beef|hamburger)\b/.test(name);
  });

  const hasSeafood = extendedIngredients.some(ing => {
    const name = (ing.name || ing.original || '').toLowerCase();
    return /\b(shrimp|salmon|fish|tuna|seafood|lobster|crab|tilapia|cod|halibut|mahi)\b/.test(name) && !isProteinDerivative(name);
  });

  const hasPork = extendedIngredients.some(ing => {
    const name = (ing.name || ing.original || '').toLowerCase();
    return /\b(pork|bacon|ham|sausage|prosciutto|pepperoni)\b/.test(name) && !isProteinDerivative(name);
  });

  // Assign protein tags
  if (hasChicken) {
    tags.push(findTag('tag_chicken'));
  } else if (hasBeef) {
    tags.push(findTag('tag_beef'));
  } else if (hasSeafood) {
    tags.push(findTag('tag_seafood'));
  } else if (hasPork) {
    tags.push(findTag('tag_pork'));
  } else if (vegetarian || vegan || /tofu|tempeh|lentil|chickpea|beans/.test(ingredientText)) {
    tags.push(findTag('tag_plant_based'));
  }

  // === PRIORITY 5: Cuisine (from title/summary) ===
  const textToAnalyze = `${title} ${summary}`.toLowerCase();

  const cuisinePatterns = {
    italian: /pasta|italian|parmesan|marinara|risotto|lasagna|bolognese|pesto|carbonara/,
    mexican: /taco|burrito|salsa|mexican|tortilla|enchilada|quesadilla|fajita|guacamole/,
    asian: /soy sauce|ginger|asian|stir fry|teriyaki|sesame|wok|ramen|noodles/,
    mediterranean: /olive oil|feta|mediterranean|hummus|tzatziki|greek|olives/,
    indian: /curry|indian|turmeric|garam masala|tandoori|naan|biryani|tikka/,
    thai: /thai|coconut milk|lemongrass|fish sauce|pad thai|curry paste/,
    french: /french|baguette|croissant|coq au vin|ratatouille|crepe/,
    american: /burger|bbq|american|sandwich|fries|hot dog/,
  };

  for (const [cuisine, pattern] of Object.entries(cuisinePatterns)) {
    if (pattern.test(textToAnalyze)) {
      tags.push(findTag(`tag_${cuisine}`));
      break; // Only add one cuisine tag
    }
  }

  // === PRIORITY 6: Meal Type (from title) ===
  const titleLower = title.toLowerCase();
  if (/breakfast|pancake|waffle|omelette|oatmeal|cereal/.test(titleLower)) {
    tags.push(findTag('tag_breakfast'));
  } else if (/dessert|cake|cookie|brownie|pie|pudding/.test(titleLower)) {
    tags.push(findTag('tag_dessert'));
  } else if (/appetizer|starter|dip/.test(titleLower)) {
    tags.push(findTag('tag_appetizer'));
  } else if (/snack/.test(titleLower)) {
    tags.push(findTag('tag_snack'));
  }

  // === Filter and Limit ===
  // Remove duplicates and null values, limit to 3 tags
  const uniqueTags = tags.filter((tag, index, self) =>
    tag && self.findIndex(t => t && t.id === tag.id) === index
  );

  return uniqueTags.slice(0, 3);
}

module.exports = {
  generateRecipeTags,
  PREDEFINED_TAGS,
};
