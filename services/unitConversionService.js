/**
 * Unit Conversion Service
 * Converts cooking units to standard base units (ml for volume, g for weight)
 * and back to user-friendly display units
 */

// Unit conversion mappings to standard base units
const CONVERSIONS = {
  // Volume -> ml (milliliters)
  'cup': { base: 'ml', factor: 236.588 },
  'cups': { base: 'ml', factor: 236.588 },
  'c': { base: 'ml', factor: 236.588 },
  'tbsp': { base: 'ml', factor: 14.787 },
  'tablespoon': { base: 'ml', factor: 14.787 },
  'tablespoons': { base: 'ml', factor: 14.787 },
  'tbs': { base: 'ml', factor: 14.787 },
  'tb': { base: 'ml', factor: 14.787 },
  'tsp': { base: 'ml', factor: 4.929 },
  'teaspoon': { base: 'ml', factor: 4.929 },
  'teaspoons': { base: 'ml', factor: 4.929 },
  't': { base: 'ml', factor: 4.929 },
  'fl oz': { base: 'ml', factor: 29.574 },
  'fluid ounce': { base: 'ml', factor: 29.574 },
  'fluid ounces': { base: 'ml', factor: 29.574 },
  'floz': { base: 'ml', factor: 29.574 },
  'pint': { base: 'ml', factor: 473.176 },
  'pints': { base: 'ml', factor: 473.176 },
  'pt': { base: 'ml', factor: 473.176 },
  'quart': { base: 'ml', factor: 946.353 },
  'quarts': { base: 'ml', factor: 946.353 },
  'qt': { base: 'ml', factor: 946.353 },
  'gallon': { base: 'ml', factor: 3785.41 },
  'gallons': { base: 'ml', factor: 3785.41 },
  'gal': { base: 'ml', factor: 3785.41 },
  'liter': { base: 'ml', factor: 1000 },
  'liters': { base: 'ml', factor: 1000 },
  'litre': { base: 'ml', factor: 1000 },
  'litres': { base: 'ml', factor: 1000 },
  'l': { base: 'ml', factor: 1000 },
  'ml': { base: 'ml', factor: 1 },
  'milliliter': { base: 'ml', factor: 1 },
  'milliliters': { base: 'ml', factor: 1 },
  'millilitre': { base: 'ml', factor: 1 },
  'millilitres': { base: 'ml', factor: 1 },

  // Weight -> g (grams)
  'lb': { base: 'g', factor: 453.592 },
  'lbs': { base: 'g', factor: 453.592 },
  'pound': { base: 'g', factor: 453.592 },
  'pounds': { base: 'g', factor: 453.592 },
  'oz': { base: 'g', factor: 28.3495 },
  'ounce': { base: 'g', factor: 28.3495 },
  'ounces': { base: 'g', factor: 28.3495 },
  'kg': { base: 'g', factor: 1000 },
  'kilogram': { base: 'g', factor: 1000 },
  'kilograms': { base: 'g', factor: 1000 },
  'g': { base: 'g', factor: 1 },
  'gram': { base: 'g', factor: 1 },
  'grams': { base: 'g', factor: 1 },
  'mg': { base: 'g', factor: 0.001 },
  'milligram': { base: 'g', factor: 0.001 },
  'milligrams': { base: 'g', factor: 0.001 },
};

// Display thresholds for converting back to user-friendly units
const DISPLAY_CONVERSIONS = {
  'ml': [
    { threshold: 3785, unit: 'gallon', factor: 3785.41, plural: 'gallons' },
    { threshold: 946, unit: 'quart', factor: 946.353, plural: 'quarts' },
    { threshold: 236, unit: 'cup', factor: 236.588, plural: 'cups' },
    { threshold: 15, unit: 'tbsp', factor: 14.787, plural: 'tbsp' },
    { threshold: 5, unit: 'tsp', factor: 4.929, plural: 'tsp' },
    { threshold: 0, unit: 'ml', factor: 1, plural: 'ml' },
  ],
  'g': [
    { threshold: 1000, unit: 'kg', factor: 1000, plural: 'kg' },
    { threshold: 453, unit: 'lb', factor: 453.592, plural: 'lbs' },
    { threshold: 28, unit: 'oz', factor: 28.3495, plural: 'oz' },
    { threshold: 0, unit: 'g', factor: 1, plural: 'g' },
  ],
};

const unitConversionService = {
  /**
   * Normalize a unit string to a standard form
   * @param {string} unit - The unit to normalize
   * @returns {string} Normalized unit
   */
  normalizeUnit(unit) {
    if (!unit) return '';
    return unit.toLowerCase().trim().replace(/\.$/, '');
  },

  /**
   * Check if a unit is convertible (has a known conversion)
   * @param {string} unit - The unit to check
   * @returns {boolean}
   */
  isConvertibleUnit(unit) {
    const normalized = this.normalizeUnit(unit);
    return normalized in CONVERSIONS;
  },

  /**
   * Get the base unit type for a given unit
   * @param {string} unit - The unit to check
   * @returns {string|null} 'ml', 'g', or null if not convertible
   */
  getBaseUnitType(unit) {
    const normalized = this.normalizeUnit(unit);
    const conversion = CONVERSIONS[normalized];
    return conversion ? conversion.base : null;
  },

  /**
   * Check if two units can be combined (same base type)
   * @param {string} unit1 - First unit
   * @param {string} unit2 - Second unit
   * @returns {boolean}
   */
  canCombine(unit1, unit2) {
    const base1 = this.getBaseUnitType(unit1);
    const base2 = this.getBaseUnitType(unit2);

    // Both must be convertible and have the same base
    if (base1 && base2 && base1 === base2) {
      return true;
    }

    // If both units are empty or identical, they can be combined
    const norm1 = this.normalizeUnit(unit1);
    const norm2 = this.normalizeUnit(unit2);
    if (norm1 === norm2) {
      return true;
    }

    return false;
  },

  /**
   * Convert an amount to standard base units (ml or g)
   * @param {number} amount - The amount to convert
   * @param {string} unit - The unit of the amount
   * @returns {{ amount: number, unit: string }} Converted amount and base unit
   */
  convertToStandard(amount, unit) {
    if (!amount || isNaN(amount)) {
      return { amount: 0, unit: unit || '' };
    }

    const normalized = this.normalizeUnit(unit);
    const conversion = CONVERSIONS[normalized];

    if (conversion) {
      return {
        amount: amount * conversion.factor,
        unit: conversion.base,
      };
    }

    // Unit not recognized, return as-is
    return { amount, unit: normalized };
  },

  /**
   * Convert a standard amount back to a user-friendly display unit
   * @param {number} amount - The amount in base units (ml or g)
   * @param {string} baseUnit - The base unit ('ml' or 'g')
   * @returns {{ amount: number, unit: string, display: string }} Display-friendly result
   */
  convertForDisplay(amount, baseUnit) {
    if (!amount || isNaN(amount)) {
      return { amount: 0, unit: baseUnit || '', display: '0' };
    }

    const conversions = DISPLAY_CONVERSIONS[baseUnit];
    if (!conversions) {
      // Not a base unit we convert, format as-is
      const rounded = this.roundForDisplay(amount);
      return {
        amount: rounded,
        unit: baseUnit || '',
        display: `${rounded}${baseUnit ? ' ' + baseUnit : ''}`
      };
    }

    // Find the appropriate display unit
    for (const conv of conversions) {
      if (amount >= conv.threshold) {
        const converted = amount / conv.factor;
        const rounded = this.roundForDisplay(converted);
        const unitLabel = rounded === 1 ? conv.unit : conv.plural;
        return {
          amount: rounded,
          unit: unitLabel,
          display: `${rounded} ${unitLabel}`,
        };
      }
    }

    // Fallback
    const rounded = this.roundForDisplay(amount);
    return { amount: rounded, unit: baseUnit, display: `${rounded} ${baseUnit}` };
  },

  /**
   * Round a number for display (handles fractions nicely)
   * @param {number} num - Number to round
   * @returns {number|string} Rounded number
   */
  roundForDisplay(num) {
    if (num === 0) return 0;

    // Check for common fractions
    const fractions = [
      { decimal: 0.25, display: 0.25 },
      { decimal: 0.33, display: 0.33 },
      { decimal: 0.5, display: 0.5 },
      { decimal: 0.67, display: 0.67 },
      { decimal: 0.75, display: 0.75 },
    ];

    const whole = Math.floor(num);
    const decimal = num - whole;

    // If very close to a whole number
    if (decimal < 0.05) return whole || num.toFixed(1);
    if (decimal > 0.95) return whole + 1;

    // Round to 2 decimal places for display
    const rounded = Math.round(num * 100) / 100;

    // Clean up trailing zeros
    if (rounded === Math.floor(rounded)) {
      return Math.floor(rounded);
    }

    return rounded;
  },

  /**
   * Combine two quantities with potentially different units
   * @param {number} amount1 - First amount
   * @param {string} unit1 - First unit
   * @param {number} amount2 - Second amount
   * @param {string} unit2 - Second unit
   * @returns {{ amount: number, unit: string, display: string }|null} Combined result or null if can't combine
   */
  combineQuantities(amount1, unit1, amount2, unit2) {
    if (!this.canCombine(unit1, unit2)) {
      return null;
    }

    // If both units are the same (or equivalent like "lb" and "lbs"), just add directly
    // This preserves the user's preferred unit (e.g., lbs + lbs = lbs, not kg)
    const norm1 = this.normalizeUnit(unit1);
    const norm2 = this.normalizeUnit(unit2);
    if (norm1 === norm2 || this.areEquivalentUnits(unit1, unit2)) {
      const total = this.roundForDisplay(amount1 + amount2);
      const displayUnit = unit1 || unit2; // Use the first non-empty unit
      return {
        amount: total,
        unit: displayUnit,
        display: `${total}${displayUnit ? ' ' + displayUnit : ''}`,
      };
    }

    const std1 = this.convertToStandard(amount1, unit1);
    const std2 = this.convertToStandard(amount2, unit2);

    // If both converted to the same base unit (different original units like oz + lbs)
    if (std1.unit === std2.unit && (std1.unit === 'ml' || std1.unit === 'g')) {
      const totalStandard = std1.amount + std2.amount;
      return this.convertForDisplay(totalStandard, std1.unit);
    }

    // Same non-convertible unit
    if (std1.unit === std2.unit) {
      const total = std1.amount + std2.amount;
      const rounded = this.roundForDisplay(total);
      return {
        amount: rounded,
        unit: std1.unit,
        display: `${rounded}${std1.unit ? ' ' + std1.unit : ''}`,
      };
    }

    return null;
  },

  /**
   * Check if two units are equivalent (e.g., "lb" and "lbs", "cup" and "cups")
   */
  areEquivalentUnits(unit1, unit2) {
    const norm1 = this.normalizeUnit(unit1);
    const norm2 = this.normalizeUnit(unit2);

    // Check if they map to the same base unit
    const base1 = this.getBaseUnitType(unit1);
    const base2 = this.getBaseUnitType(unit2);

    if (!base1 || !base2) return false;

    // Get conversion factors - if same factor and same base, they're equivalent
    const conv1 = CONVERSIONS[norm1];
    const conv2 = CONVERSIONS[norm2];

    return conv1 && conv2 && conv1.base === conv2.base && conv1.factor === conv2.factor;
  },
};

module.exports = unitConversionService;
