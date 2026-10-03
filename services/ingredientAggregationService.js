/**
 * Ingredient Aggregation Service
 * Aggregates ingredients from multiple recipes, combining quantities with unit conversion
 */

const unitConversionService = require('./unitConversionService');
const categoryService = require('./categoryService');

// Rough grams per millilitre, for adding a weight to a volume of the same
// ingredient (10 g of butter + 2 tbsp of butter). Anything not listed counts
// 1 ml as 1 g. A shopping estimate, not a kitchen conversion.
const DENSITIES = [
  [/\b(butter|margarine)\b/, 0.96],
  [/\boil\b/, 0.92],
  [/\bflour\b/, 0.53],
  [/\bsugar\b/, 0.85],
  [/\b(honey|syrup|molasses)\b/, 1.4],
  [/\brice\b/, 0.85],
  [/\bsalt\b/, 1.2],
];

const METRIC_UNITS = new Set([
  'g', 'gram', 'grams', 'kg', 'kilogram', 'kilograms', 'mg',
  'ml', 'milliliter', 'milliliters', 'millilitre', 'millilitres',
  'l', 'liter', 'liters', 'litre', 'litres',
]);

// A source's quantity as a positive number, or null when it has none
const sourceAmount = (quantity) => {
  if (quantity === null || quantity === undefined || String(quantity).trim() === '') return null;
  const amount = Number(quantity);
  return Number.isFinite(amount) && amount > 0 ? amount : null;
};

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
   * Record one recipe's share of an aggregated ingredient, so a merged row can
   * still be shown under each dish with that dish's own quantity.
   * The same recipe appearing again (planned twice) adds to its entry when the
   * unit matches; otherwise it gets a second entry.
   * @param {Array} sources - The ingredient's sources array (mutated)
   * @param {Object} recipe - Recipe with id, title and optional image
   * @param {number} amount - This occurrence's amount
   * @param {string} unit - This occurrence's unit
   */
  recordSource(sources, recipe, amount, unit) {
    if (recipe.id === undefined || recipe.id === null || !recipe.title) return;

    const recipeId = String(recipe.id);
    const sourceUnit = unit || null;
    const existing = sources.find(s => s.recipe_id === recipeId && s.unit === sourceUnit);

    if (existing) {
      existing.quantity = String(unitConversionService.roundForDisplay(parseFloat(existing.quantity) + amount));
      return;
    }

    sources.push({
      recipe_id: recipeId,
      title: recipe.title,
      image: recipe.image || null,
      quantity: String(unitConversionService.roundForDisplay(amount)),
      unit: sourceUnit,
    });
  },

  /**
   * Work out one best-effort total for an ingredient from each recipe's share.
   * Meant for a shopper, so it always answers, even across units that don't
   * truly convert:
   *   - same kind of unit: added (500 g + 500 g = 1 kg)
   *   - a bare count and a named count: the bare one takes the name (2 + 2 cloves = 4 cloves)
   *   - a weight and a volume: the volume is turned into grams by rough density
   *   - a count against a weight or volume: listed side by side (1 head + 2 cups)
   *   - a share with no amount: the known total "+ some"
   * @param {string} name - Ingredient name (picks the density)
   * @param {Array} sources - [{ quantity, unit }] per recipe
   * @returns {{ quantity: string|null, unit: string }} quantity is a plain number
   *   when there is a single total; otherwise the whole label with unit ''
   */
  summarizeSources(name, sources) {
    const round = (n) => unitConversionService.roundForDisplay(n);
    let grams = 0;
    let millilitres = 0;
    let unknown = false;
    const weightUnits = new Map(); // normalized unit -> unit as written
    const volumeUnits = new Map();
    const counts = new Map(); // singular unit -> { amount, unit }

    for (const source of sources || []) {
      const amount = sourceAmount(source.quantity);
      if (amount === null) {
        unknown = true;
        continue;
      }

      const normalized = unitConversionService.normalizeUnit(source.unit);
      const base = unitConversionService.getBaseUnitType(source.unit);

      if (base === 'g') {
        grams += unitConversionService.convertToStandard(amount, source.unit).amount;
        if (!weightUnits.has(normalized)) weightUnits.set(normalized, source.unit);
      } else if (base === 'ml') {
        millilitres += unitConversionService.convertToStandard(amount, source.unit).amount;
        if (!volumeUnits.has(normalized)) volumeUnits.set(normalized, source.unit);
      } else {
        const key = normalized.replace(/s$/, '');
        const entry = counts.get(key);
        if (entry) {
          entry.amount += amount;
        } else {
          counts.set(key, { amount, unit: source.unit || '' });
        }
      }
    }

    // "2" and "2 cloves" are both cloves
    const named = [...counts.keys()].filter(key => key !== '');
    if (counts.has('') && named.length === 1) {
      counts.get(named[0]).amount += counts.get('').amount;
      counts.delete('');
    }

    // A weight and a volume: everything becomes grams
    let estimated = false;
    if (grams > 0 && millilitres > 0) {
      const lowered = (name || '').toLowerCase();
      const density = (DENSITIES.find(([pattern]) => pattern.test(lowered)) || [null, 1])[1];
      // Whole grams: decimals would suggest a precision the estimate lacks
      grams = Math.round(grams + millilitres * density);
      millilitres = 0;
      estimated = true;
    }

    // One unit stays as written, metric stays metric (kg / L from 1000);
    // anything else goes through the shared display conversion
    const measure = (total, base, units, big, factor) => {
      const allMetric = [...units.keys()].every(unit => METRIC_UNITS.has(unit));
      if (units.size === 1 && !estimated && !allMetric) {
        const [normalized, written] = [...units.entries()][0];
        const perUnit = unitConversionService.convertToStandard(1, normalized).amount;
        return { amount: round(total / perUnit), unit: written };
      }
      if (allMetric) {
        return total >= factor
          ? { amount: round(total / factor), unit: big }
          : { amount: round(total), unit: base };
      }
      const display = unitConversionService.convertForDisplay(total, base);
      return { amount: display.amount, unit: display.unit };
    };

    const parts = [];
    if (grams > 0) parts.push(measure(grams, 'g', weightUnits, 'kg', 1000));
    if (millilitres > 0) parts.push(measure(millilitres, 'ml', volumeUnits, 'L', 1000));
    for (const entry of counts.values()) {
      parts.push({ amount: round(entry.amount), unit: entry.unit });
    }

    if (parts.length === 0) {
      // No recipe gave an amount: keep the unit only if they all agree on it
      const units = new Set((sources || []).map(source => unitConversionService.normalizeUnit(source.unit)));
      return { quantity: null, unit: units.size === 1 ? ((sources || [])[0]?.unit || '') : '' };
    }

    if (parts.length === 1 && !unknown) {
      return { quantity: String(parts[0].amount), unit: parts[0].unit };
    }

    const label = parts.map(part => `${part.amount}${part.unit ? ' ' + part.unit : ''}`).join(' + ');
    return { quantity: unknown ? `${label} + some` : label, unit: '' };
  },

  /**
   * Aggregate ingredients from multiple recipes
   * @param {Array} recipes - Array of recipe objects with extendedIngredients
   *   (plus id, title and image when the caller wants per-recipe sources)
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
          // Recorded even when the units can't be combined below, so the dish
          // still lists the ingredient
          this.recordSource(existing.sources, recipe, amount, unit);

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
              // If units are different and can't combine, the total comes
              // from summarizeSources below
              else {
                existing.uncombined = true;
              }
            }
          } else {
            // Incompatible units ("1 head" vs "2 cups"): the running amount
            // can't take this one, so the total comes from summarizeSources below
            existing.uncombined = true;
          }
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

          const sources = [];
          this.recordSource(sources, recipe, amount, unit);

          ingredientMap.set(normalizedName, {
            name: rawName,
            normalizedName,
            amount: displayResult.amount,
            unit: displayResult.unit,
            display: displayResult.display,
            original: ing.original,
            sources,
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
    const result = ingredientList.map(ing => {
      let quantity = String(ing.amount);
      let unit = ing.unit;
      let display = ing.display;

      // An amount was left out of the running total: give the shopper a
      // best-effort total across every recipe's share instead
      if (ing.uncombined && ing.sources.length > 0) {
        const total = this.summarizeSources(ing.name, ing.sources);
        if (total.quantity) {
          quantity = total.quantity;
          unit = total.unit;
          display = `${quantity}${unit ? ' ' + unit : ''}`;
        }
      }

      return {
        name: ing.name,
        quantity,
        unit,
        display,
        category: categories[ing.name] || 'Other',
        sources: ing.sources,
      };
    });

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
          nameEn: ing.nameEn || null, // canonical English name for cross-language icon lookup; first occurrence wins on merge
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
