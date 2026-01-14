/**
 * Ingredient Aggregation Service
 * Aggregates ingredients from multiple recipes, combining quantities with unit conversion
 */

const unitConversionService = require('./unitConversionService');
const categoryService = require('./categoryService');

const ingredientAggregationService = {
  /**
   * Normalize an ingredient name for comparison
   * @param {string} name - The ingredient name
   * @returns {string} Normalized name
   */
  normalizeIngredientName(name) {
    if (!name) return '';

    return name
      .toLowerCase()
      .trim()
      // Remove leading articles and cooking state descriptors
      .replace(/^(a |an |the |some |fresh |dried |ground |chopped |minced |diced |sliced |whole |large |medium |small |extra |very |uncooked |cooked |raw )/gi, '')
      // Remove parenthetical notes
      .replace(/\([^)]*\)/g, '')
      // Remove trailing preparation instructions after comma (e.g., ", diced" or ", peeled and diced")
      .replace(/,\s*(and\s+)?(peeled|diced|sliced|chopped|minced|cubed|julienned|shredded|grated|cut|trimmed|halved|quartered|crushed|torn|roughly|finely|thinly)(\s+(and\s+)?(peeled|diced|sliced|chopped|minced|cubed|julienned|shredded|grated|cut|trimmed|halved|quartered|crushed|torn|roughly|finely|thinly))*.*$/gi, '')
      // Remove extra whitespace
      .replace(/\s+/g, ' ')
      .trim();
  },

  /**
   * Extract a clean ingredient name from potentially messy recipe data
   * @param {Object} ingredient - Ingredient object from recipe
   * @returns {string} Clean ingredient name
   */
  extractIngredientName(ingredient) {
    // Try different fields that might contain the name
    const name = ingredient.name || ingredient.ingredient || ingredient.item || '';

    // If name is empty, try to parse from 'original' string
    if (!name && ingredient.original) {
      // Original format is often "2 cups flour" - extract the ingredient part
      const parts = ingredient.original.split(' ');
      // Skip numbers and units at the beginning
      const filtered = parts.filter(p => !p.match(/^[\d./]+$/) && !unitConversionService.isConvertibleUnit(p));
      return filtered.join(' ');
    }

    return name;
  },

  /**
   * Aggregate ingredients from multiple recipes
   * @param {Array} recipes - Array of recipe objects with extendedIngredients
   * @returns {Promise<Object>} Aggregated ingredients grouped by category
   */
  async aggregateIngredients(recipes) {
    const ingredientMap = new Map();

    // Process each recipe
    for (const recipe of recipes) {
      const ingredients = recipe.extendedIngredients ||
                         recipe.recipe_snapshot?.extendedIngredients ||
                         recipe.ingredients ||
                         [];

      for (const ing of ingredients) {
        const rawName = this.extractIngredientName(ing);
        if (!rawName) continue;

        const normalizedName = this.normalizeIngredientName(rawName);
        if (!normalizedName) continue;

        const amount = parseFloat(ing.amount) || 1;
        const unit = ing.unit || '';

        const existing = ingredientMap.get(normalizedName);

        if (existing) {
          // Try to combine with existing
          if (unitConversionService.canCombine(existing.unit, unit)) {
            const combined = unitConversionService.combineQuantities(
              existing.amount,
              existing.unit,
              amount,
              unit
            );

            if (combined) {
              existing.amount = combined.amount;
              existing.unit = combined.unit;
              existing.display = combined.display;
            } else {
              // Fallback: just add the amounts if same unit
              if (existing.unit === unit || (!existing.unit && !unit)) {
                existing.amount = unitConversionService.roundForDisplay(existing.amount + amount);
              }
              // If units are different and can't combine, keep the first one
              // (rare edge case)
            }
          }
          // If units are incompatible, keep the original (don't combine "1 head" with "2 cups")
        } else {
          // New ingredient
          const stdResult = unitConversionService.convertToStandard(amount, unit);
          let displayResult;

          if (stdResult.unit === 'ml' || stdResult.unit === 'g') {
            displayResult = unitConversionService.convertForDisplay(stdResult.amount, stdResult.unit);
          } else {
            displayResult = {
              amount: unitConversionService.roundForDisplay(amount),
              unit: unit,
              display: `${unitConversionService.roundForDisplay(amount)}${unit ? ' ' + unit : ''}`,
            };
          }

          ingredientMap.set(normalizedName, {
            name: rawName,
            normalizedName,
            amount: displayResult.amount,
            unit: displayResult.unit,
            display: displayResult.display,
            original: ing.original,
          });
        }
      }
    }

    // Convert to array and categorize
    const ingredientNames = [];
    const ingredientList = [];

    for (const [key, ing] of ingredientMap) {
      ingredientNames.push(ing.name);
      ingredientList.push(ing);
    }

    // Get categories for all ingredients
    const categories = await categoryService.categorizeItems(ingredientNames);

    // Build result with categories
    const result = ingredientList.map(ing => ({
      name: ing.name,
      quantity: String(ing.amount),
      unit: ing.unit,
      display: ing.display,
      category: categories[ing.name] || 'Other',
    }));

    // Group by category
    return this.groupByCategory(result);
  },

  /**
   * Aggregate duplicate ingredients within a single recipe
   * Used when a recipe may have the same ingredient listed multiple times
   * (e.g., salt for steak, salt for sauce, salt for mashed potatoes)
   * @param {Array} ingredients - Array of ingredient objects from recipe
   * @returns {Array} Aggregated ingredients with duplicates combined
   */
  aggregateSingleRecipe(ingredients) {
    if (!Array.isArray(ingredients) || ingredients.length === 0) {
      return ingredients;
    }

    const ingredientMap = new Map();

    for (const ing of ingredients) {
      const rawName = this.extractIngredientName(ing);
      if (!rawName) continue;

      const normalizedName = this.normalizeIngredientName(rawName);
      if (!normalizedName) continue;

      const amount = parseFloat(ing.amount) || 0;
      const unit = ing.unit || '';

      const existing = ingredientMap.get(normalizedName);

      if (existing) {
        // Try to combine quantities
        if (unitConversionService.canCombine(existing.unit, unit)) {
          const combined = unitConversionService.combineQuantities(
            existing.amount,
            existing.unit,
            amount,
            unit
          );

          if (combined) {
            existing.amount = combined.amount;
            existing.unit = combined.unit;
            existing.aggregatedCount = (existing.aggregatedCount || 1) + 1;
          } else if (existing.unit === unit || (!existing.unit && !unit)) {
            // Same unit or both unitless - just add amounts
            existing.amount = unitConversionService.roundForDisplay(existing.amount + amount);
            existing.aggregatedCount = (existing.aggregatedCount || 1) + 1;
          }
          // Otherwise units are incompatible - keep first occurrence
        } else if (existing.unit === unit || (!existing.unit && !unit)) {
          // Same unit or both unitless - just add amounts
          existing.amount = unitConversionService.roundForDisplay(existing.amount + amount);
          existing.aggregatedCount = (existing.aggregatedCount || 1) + 1;
        }
        // If units are truly incompatible (e.g., "1 head" + "2 cups"), keep first occurrence
      } else {
        // First occurrence of this ingredient
        ingredientMap.set(normalizedName, {
          original: ing.original,
          name: rawName,
          amount: amount || null,
          unit: unit,
          aggregatedCount: 1
        });
      }
    }

    // Convert Map back to array, preserving order of first occurrence
    return Array.from(ingredientMap.values());
  },

  /**
   * Group ingredients by their category
   * @param {Array} ingredients - Array of ingredient objects with category field
   * @returns {Object} Ingredients grouped by category
   */
  groupByCategory(ingredients) {
    // Define category order for display
    const categoryOrder = [
      'Produce',
      'Meat & Seafood',
      'Dairy & Eggs',
      'Bakery & Bread',
      'Pantry & Canned Goods',
      'Frozen Foods',
      'Condiments & Sauces',
      'Snacks & Beverages',
      'Other',
    ];

    const grouped = {};

    // Initialize categories in order
    for (const cat of categoryOrder) {
      grouped[cat] = [];
    }

    // Group ingredients
    for (const ing of ingredients) {
      const category = ing.category || 'Other';
      if (!grouped[category]) {
        grouped[category] = [];
      }
      grouped[category].push(ing);
    }

    // Remove empty categories
    for (const cat of Object.keys(grouped)) {
      if (grouped[cat].length === 0) {
        delete grouped[cat];
      }
    }

    // Sort ingredients within each category alphabetically
    for (const cat of Object.keys(grouped)) {
      grouped[cat].sort((a, b) => a.name.localeCompare(b.name));
    }

    return grouped;
  },

  /**
   * Flatten grouped ingredients back to array
   * @param {Object} grouped - Grouped ingredients object
   * @returns {Array} Flat array of ingredients
   */
  flattenGrouped(grouped) {
    const result = [];
    for (const category of Object.keys(grouped)) {
      for (const ing of grouped[category]) {
        result.push(ing);
      }
    }
    return result;
  },

  /**
   * Get summary statistics for aggregated ingredients
   * @param {Object} grouped - Grouped ingredients object
   * @returns {Object} Summary stats
   */
  getSummary(grouped) {
    let totalItems = 0;
    const categoryCounts = {};

    for (const [category, items] of Object.entries(grouped)) {
      totalItems += items.length;
      categoryCounts[category] = items.length;
    }

    return {
      totalItems,
      categoryCount: Object.keys(grouped).length,
      categoryCounts,
    };
  },
};

module.exports = ingredientAggregationService;
