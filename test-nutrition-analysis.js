#!/usr/bin/env node

/**
 * Test script for AI-powered nutrition analysis
 * Usage: node test-nutrition-analysis.js
 */

require('dotenv').config();
const NutritionAnalysisService = require('./services/nutritionAnalysisService');

// Test recipes
const testRecipes = [
  {
    title: "Grilled Chicken Salad",
    servings: 2,
    extendedIngredients: [
      { amount: 1, unit: "pound", name: "chicken breast", original: "1 pound boneless chicken breast" },
      { amount: 4, unit: "cups", name: "mixed greens", original: "4 cups mixed salad greens" },
      { amount: 1, unit: "cup", name: "cherry tomatoes", original: "1 cup cherry tomatoes, halved" },
      { amount: 0.5, unit: "cup", name: "cucumber", original: "1/2 cup sliced cucumber" },
      { amount: 0.25, unit: "cup", name: "red onion", original: "1/4 cup sliced red onion" },
      { amount: 2, unit: "tablespoons", name: "olive oil", original: "2 tablespoons olive oil" },
      { amount: 1, unit: "tablespoon", name: "lemon juice", original: "1 tablespoon fresh lemon juice" }
    ]
  },
  {
    title: "Creamy Pasta Carbonara",
    servings: 4,
    extendedIngredients: [
      { amount: 1, unit: "pound", name: "spaghetti", original: "1 pound spaghetti pasta" },
      { amount: 6, unit: "slices", name: "bacon", original: "6 slices bacon, chopped" },
      { amount: 3, unit: "", name: "eggs", original: "3 large eggs" },
      { amount: 1, unit: "cup", name: "Parmesan cheese", original: "1 cup grated Parmesan cheese" },
      { amount: 2, unit: "cloves", name: "garlic", original: "2 cloves garlic, minced" },
      { amount: 0.5, unit: "cup", name: "heavy cream", original: "1/2 cup heavy cream" },
      { amount: 1, unit: "serving", name: "black pepper", original: "Black pepper to taste" }
    ]
  },
  {
    title: "Vegetable Stir-Fry",
    servings: 3,
    extendedIngredients: [
      { amount: 2, unit: "cups", name: "broccoli", original: "2 cups broccoli florets" },
      { amount: 1, unit: "cup", name: "bell pepper", original: "1 cup sliced bell peppers" },
      { amount: 1, unit: "cup", name: "snap peas", original: "1 cup sugar snap peas" },
      { amount: 1, unit: "cup", name: "mushrooms", original: "1 cup sliced mushrooms" },
      { amount: 2, unit: "tablespoons", name: "soy sauce", original: "2 tablespoons soy sauce" },
      { amount: 1, unit: "tablespoon", name: "sesame oil", original: "1 tablespoon sesame oil" },
      { amount: 1, unit: "tablespoon", name: "cornstarch", original: "1 tablespoon cornstarch" },
      { amount: 2, unit: "cloves", name: "garlic", original: "2 cloves garlic, minced" },
      { amount: 1, unit: "teaspoon", name: "ginger", original: "1 teaspoon fresh grated ginger" }
    ]
  }
];

async function testNutritionAnalysis() {
  console.log('🧪 Starting Nutrition Analysis Tests\n');
  console.log('='.repeat(50));

  const nutritionService = new NutritionAnalysisService();

  for (const recipe of testRecipes) {
    console.log(`\n📋 Testing: ${recipe.title}`);
    console.log('-'.repeat(40));
    console.log(`Servings: ${recipe.servings}`);
    console.log(`Ingredients: ${recipe.extendedIngredients.length} items`);

    try {
      const startTime = Date.now();
      const nutritionData = await nutritionService.analyzeRecipeNutrition(recipe);
      const elapsed = Date.now() - startTime;

      if (nutritionData) {
        console.log('\n✅ Nutrition Analysis Successful!');
        console.log(`⏱️  Time taken: ${elapsed}ms`);
        console.log(`🎯 Confidence: ${Math.round((nutritionData.confidence || 0.85) * 100)}%`);

        if (nutritionData.isAIEstimated) {
          console.log('🤖 Source: AI Estimated');
        }

        console.log('\n📊 Per Serving Nutrition:');
        console.log(`  Calories: ${nutritionData.perServing.calories.amount} kcal`);
        console.log(`  Protein: ${nutritionData.perServing.protein.amount}g`);
        console.log(`  Carbs: ${nutritionData.perServing.carbohydrates.amount}g`);
        console.log(`  Fat: ${nutritionData.perServing.fat.amount}g`);
        console.log(`  Fiber: ${nutritionData.perServing.fiber.amount}g`);
        console.log(`  Sugar: ${nutritionData.perServing.sugar.amount}g`);
        console.log(`  Sodium: ${nutritionData.perServing.sodium.amount}mg`);

        console.log('\n🥧 Caloric Breakdown:');
        console.log(`  Protein: ${nutritionData.caloricBreakdown.percentProtein}%`);
        console.log(`  Carbs: ${nutritionData.caloricBreakdown.percentCarbs}%`);
        console.log(`  Fat: ${nutritionData.caloricBreakdown.percentFat}%`);

        console.log(`\n💚 Health Score: ${nutritionData.healthScore}/100`);

        // Validate the data
        const total = nutritionData.caloricBreakdown.percentProtein +
                     nutritionData.caloricBreakdown.percentCarbs +
                     nutritionData.caloricBreakdown.percentFat;

        if (Math.abs(total - 100) > 5) {
          console.warn('⚠️  Warning: Caloric breakdown doesn\'t add up to 100%');
        }

      } else {
        console.log('❌ No nutrition data returned');
      }

    } catch (error) {
      console.error('❌ Analysis failed:', error.message);
    }

    console.log('\n' + '='.repeat(50));
  }

  // Test single ingredient analysis
  console.log('\n📋 Testing Single Ingredient Analysis');
  console.log('-'.repeat(40));

  try {
    const ingredient = await nutritionService.analyzeIngredient('chicken breast', 100, 'grams');
    if (ingredient) {
      console.log('✅ Single Ingredient Analysis:');
      console.log(`  100g chicken breast:`);
      console.log(`  Calories: ${ingredient.calories} kcal`);
      console.log(`  Protein: ${ingredient.protein}g`);
      console.log(`  Carbs: ${ingredient.carbohydrates}g`);
      console.log(`  Fat: ${ingredient.fat}g`);
      console.log(`  Confidence: ${Math.round((ingredient.confidence || 0) * 100)}%`);
    }
  } catch (error) {
    console.error('❌ Single ingredient analysis failed:', error.message);
  }

  console.log('\n✨ All tests completed!\n');
}

// Run tests
testNutritionAnalysis().catch(error => {
  console.error('Fatal error:', error);
  process.exit(1);
});