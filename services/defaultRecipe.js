const { getServiceClient } = require('../config/supabase');

/**
 * Default recipe data - automatically added to new user accounts
 * Recipe: "Rosemary Gnocchi" by @healthygirlkitchen
 * Source: https://www.instagram.com/p/DGioQ5qOWij/
 */
const DEFAULT_RECIPE_DATA = {
  title: "Rosemary Gnocchi",
  summary: "This one-pan rosemary gnocchi recipe is a simple and flavorful dish that's perfect for a cozy night in. It features gnocchi, lentils, cherry tomatoes, peppers, and spinach all baked in a delicious rosemary marinara sauce and topped with ricotta, basil and parmesan.",

  // Permanent Supabase-hosted image from Instagram
  image: "https://aimvjpndmipmtavpmjnn.supabase.co/storage/v1/object/public/recipe-images/system/default-rosemary-gnocchi-1761288018306.jpg",
  image_urls: ["https://aimvjpndmipmtavpmjnn.supabase.co/storage/v1/object/public/recipe-images/system/default-rosemary-gnocchi-1761288018306.jpg"],

  extendedIngredients: [
    {
      original: "1 jar Wild Rosemary Marinara",
      name: "Wild Rosemary Marinara",
      amount: 1,
      unit: "jar"
    },
    {
      original: "3 cups water",
      name: "water",
      amount: 3,
      unit: "cup"
    },
    {
      original: "1 16 oz package gnocchi",
      name: "gnocchi",
      amount: 16,
      unit: "ounce"
    },
    {
      original: "1 15 oz can lentils drained and rinsed",
      name: "lentils",
      amount: 15,
      unit: "ounce"
    },
    {
      original: "6 cloves minced garlic",
      name: "minced garlic",
      amount: 6,
      unit: "cloves"
    },
    {
      original: "1 cup halved cherry tomatoes",
      name: "halved cherry tomatoes",
      amount: 1,
      unit: "cup"
    },
    {
      original: "1 cup diced bell pepper",
      name: "diced bell pepper",
      amount: 1,
      unit: "cup"
    },
    {
      original: "1 cup chopped spinach",
      name: "chopped spinach",
      amount: 1,
      unit: "cup"
    },
    {
      original: "1 tsp salt",
      name: "salt",
      amount: 1,
      unit: "tsp"
    },
    {
      original: "1/2 tsp pepper",
      name: "pepper",
      amount: 0.5,
      unit: "tsp"
    },
    {
      original: "1/3 cup dairy-free ricotta cheese",
      name: "dairy-free ricotta cheese",
      amount: 0.333333333,
      unit: "cup"
    },
    {
      original: "Basil for garnish",
      name: "basil",
      amount: 0,
      unit: ""
    },
    {
      original: "Vegan parmesan for garnish",
      name: "vegan parmesan",
      amount: 0,
      unit: ""
    }
  ],

  analyzedInstructions: [
    {
      name: "",
      steps: [
        {
          number: 1,
          step: "Preheat oven to 400 F."
        },
        {
          number: 2,
          step: "In a 9x13 casserole dish mix all ingredients together until combined well."
        },
        {
          number: 3,
          step: "Bake uncovered for 30-40 minutes until gnocchi is tender."
        },
        {
          number: 4,
          step: "Mix in dairy-free ricotta and garnish with basil and vegan parmesan."
        },
        {
          number: 5,
          step: "Serve hot and enjoy."
        }
      ]
    }
  ],

  readyInMinutes: 45,
  cookingMinutes: 40,
  servings: 6,

  // Dietary attributes
  vegetarian: true,
  vegan: true,
  glutenFree: false,
  dairyFree: true,

  // Metadata
  cuisines: ["Italian"],
  dishTypes: ["main course"],
  diets: ["vegan", "vegetarian", "dairy free"],

  // Source information
  source_type: "instagram",
  source_url: "https://www.instagram.com/p/DGioQ5qOWij/",
  source_author: "healthygirlkitchen",
  source_author_image: "",
  import_method: "default_seed",

  // AI metadata
  extraction_confidence: 0.95,
  extraction_notes: "Default welcome recipe - One Pan Cozy Rosemary Gnocchi by @healthygirlkitchen",
  ai_model_used: "gemini-2.0-flash-exp",

  // AI-generated nutrition data
  nutrition: {
    confidence: 0.85,
    perServing: {
      calories: {
        unit: "kcal",
        amount: 425,
        percentOfDailyNeeds: 21
      },
      protein: {
        unit: "g",
        amount: 16,
        percentOfDailyNeeds: 32
      },
      carbohydrates: {
        unit: "g",
        amount: 63,
        percentOfDailyNeeds: 21
      },
      fat: {
        unit: "g",
        amount: 11,
        percentOfDailyNeeds: 17
      },
      saturatedFat: {
        unit: "g",
        amount: 2,
        percentOfDailyNeeds: 9
      },
      fiber: {
        unit: "g",
        amount: 9,
        percentOfDailyNeeds: 37
      },
      sugar: {
        unit: "g",
        amount: 13,
        percentOfDailyNeeds: 27
      },
      sodium: {
        unit: "mg",
        amount: 1000,
        percentOfDailyNeeds: 43
      },
      cholesterol: {
        unit: "mg",
        amount: 0,
        percentOfDailyNeeds: 0
      }
    },
    healthScore: 65,
    isAIEstimated: true,
    estimationNotes: "Nutritional values are estimated based on standard ingredient databases and typical values. Marinara sauce sodium content can vary significantly by brand, so sodium is a rough estimate. Dairy-free ricotta and vegan parmesan values are based on common commercial products.",
    caloricBreakdown: {
      percentProtein: 15,
      percentFat: 25,
      percentCarbs: 60
    }
  }
};

/**
 * Create default recipe for a new user
 * @param {string} userId - The new user's ID
 * @returns {Promise<Object>} - The created recipe or null if failed
 */
async function createDefaultRecipe(userId) {
  try {
    console.log(`[DefaultRecipe] Creating default recipe for user: ${userId}`);

    const supabase = getServiceClient();

    // Prepare recipe data with user ID
    const recipeToInsert = {
      user_id: userId,
      ...DEFAULT_RECIPE_DATA
    };

    // Insert into database
    const { data: savedRecipe, error } = await supabase
      .from('saved_recipes')
      .insert(recipeToInsert)
      .select()
      .single();

    if (error) {
      console.error('[DefaultRecipe] Failed to create default recipe:', error);
      return null;
    }

    console.log('[DefaultRecipe] Successfully created default recipe:', {
      id: savedRecipe.id,
      title: savedRecipe.title,
      userId: userId
    });

    return savedRecipe;

  } catch (error) {
    console.error('[DefaultRecipe] Error creating default recipe:', error);
    // Don't throw - we want signup to succeed even if recipe creation fails
    return null;
  }
}

/**
 * Get the default recipe data (for testing/preview)
 * @returns {Object} - The default recipe data
 */
function getDefaultRecipeData() {
  return DEFAULT_RECIPE_DATA;
}

module.exports = {
  createDefaultRecipe,
  getDefaultRecipeData,
  DEFAULT_RECIPE_DATA
};
