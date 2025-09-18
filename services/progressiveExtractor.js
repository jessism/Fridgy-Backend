const RecipeAIExtractor = require('./recipeAIExtractor');

class ProgressiveExtractor {
  constructor() {
    this.recipeAI = new RecipeAIExtractor();
    this.confidenceThresholds = {
      tier1: 0.5,   // Minimum confidence for Tier 1 success
      tier2: 0.65,  // Minimum confidence for Tier 2 success
      tier3: 0.8    // Expected confidence for Tier 3
    };
  }

  /**
   * Progressive enhancement extraction with automatic tier selection
   * @param {object} sourceData - Instagram/Apify data
   * @param {object} options - Extraction options
   * @returns {object} - Best extraction result
   */
  async extractWithProgressiveEnhancement(sourceData, options = {}) {
    const {
      maxTier = 3,           // Maximum tier to attempt
      costOptimized = true,  // Prefer lower tiers when sufficient
      userTier = 'free',     // User subscription tier
      forceVideo = false     // Force video analysis even if caption is good
    } = options;

    console.log('[ProgressiveExtractor] Starting progressive extraction:', {
      hasCaption: !!sourceData.caption,
      hasVideo: !!sourceData.videoUrl,
      videoDuration: sourceData.videoDuration,
      maxTier,
      costOptimized,
      userTier
    });

    const results = {
      tier1: null,
      tier2: null,
      tier3: null,
      selected: null,
      metadata: {
        startTime: Date.now(),
        tiersAttempted: [],
        totalCost: 0
      }
    };

    // TIER 1: Caption-based extraction (always attempt first)
    console.log('[ProgressiveExtractor] === TIER 1: Caption Analysis ===');
    results.tier1 = await this.recipeAI.extractFromApifyData(sourceData);
    results.metadata.tiersAttempted.push(1);
    results.metadata.totalCost += this.estimateCost('tier1');

    // Check if Tier 1 is sufficient
    if (this.isSufficient(results.tier1, 'tier1') && costOptimized && !forceVideo) {
      console.log('[ProgressiveExtractor] ✅ Tier 1 sufficient, stopping here');
      results.selected = results.tier1;
      results.metadata.selectedTier = 1;
      results.metadata.reason = 'Tier 1 met confidence threshold';
      return this.finalizeResult(results);
    }

    // Check if we should proceed to Tier 2
    if (maxTier < 2 || !sourceData.videoUrl) {
      console.log('[ProgressiveExtractor] ⚠️ Cannot proceed to Tier 2 (no video or max tier reached)');
      results.selected = results.tier1;
      results.metadata.selectedTier = 1;
      results.metadata.reason = 'No video available or tier limit reached';
      return this.finalizeResult(results);
    }

    // TIER 2: Video URL analysis
    console.log('[ProgressiveExtractor] === TIER 2: Video Analysis ===');
    results.tier2 = await this.recipeAI.extractFromVideoData(sourceData);
    results.metadata.tiersAttempted.push(2);
    results.metadata.totalCost += this.estimateCost('tier2');

    // Handle video expiration
    if (results.tier2.videoExpired) {
      console.log('[ProgressiveExtractor] ⚠️ Video expired, using Tier 1');
      results.selected = results.tier1;
      results.metadata.selectedTier = 1;
      results.metadata.reason = 'Video URL expired';
      return this.finalizeResult(results);
    }

    // Check if Tier 2 is sufficient
    if (this.isSufficient(results.tier2, 'tier2') && costOptimized) {
      console.log('[ProgressiveExtractor] ✅ Tier 2 sufficient, stopping here');
      results.selected = results.tier2;
      results.metadata.selectedTier = 2;
      results.metadata.reason = 'Tier 2 met confidence threshold';
      return this.finalizeResult(results);
    }

    // Check if we should proceed to Tier 3
    if (maxTier < 3 || userTier === 'free' || sourceData.videoDuration < 15) {
      console.log('[ProgressiveExtractor] ⚠️ Cannot proceed to Tier 3 (tier limit or video too short)');
      results.selected = this.selectBest([results.tier1, results.tier2]);
      results.metadata.selectedTier = results.selected.tier || 2;
      results.metadata.reason = 'Tier 3 not available';
      return this.finalizeResult(results);
    }

    // TIER 3: Frame extraction analysis (Premium only)
    console.log('[ProgressiveExtractor] === TIER 3: Frame Extraction ===');
    results.tier3 = await this.recipeAI.extractWithFrameSampling(sourceData);
    results.metadata.tiersAttempted.push(3);
    results.metadata.totalCost += this.estimateCost('tier3');

    // Select best result
    results.selected = this.selectBest([results.tier1, results.tier2, results.tier3]);
    results.metadata.selectedTier = results.selected.tier || 3;
    results.metadata.reason = 'Best of all tiers selected';

    return this.finalizeResult(results);
  }

  /**
   * Check if extraction result meets tier requirements
   * @param {object} result - Extraction result
   * @param {string} tier - Tier name
   * @returns {boolean} - Whether result is sufficient
   */
  isSufficient(result, tier) {
    if (!result || !result.success) return false;

    const threshold = this.confidenceThresholds[tier];
    const meetsConfidence = result.confidence >= threshold;

    // Additional quality checks
    const hasIngredients = result.recipe?.extendedIngredients?.length > 3;
    const hasInstructions = result.recipe?.analyzedInstructions?.[0]?.steps?.length > 2;
    const hasTitle = result.recipe?.title && result.recipe.title !== 'Untitled Recipe';

    const qualityScore = [hasIngredients, hasInstructions, hasTitle].filter(Boolean).length / 3;

    console.log(`[ProgressiveExtractor] ${tier} sufficiency check:`, {
      confidence: result.confidence,
      threshold,
      meetsConfidence,
      qualityScore,
      isSufficient: meetsConfidence && qualityScore >= 0.66
    });

    return meetsConfidence && qualityScore >= 0.66;
  }

  /**
   * Select best result from multiple tiers
   * @param {Array} results - Array of extraction results
   * @returns {object} - Best result
   */
  selectBest(results) {
    const validResults = results.filter(r => r && r.success);

    if (validResults.length === 0) {
      return results[0] || { success: false, error: 'No valid extraction' };
    }

    // Sort by confidence and tier
    return validResults.sort((a, b) => {
      // Prefer higher confidence
      const confDiff = (b.confidence || 0) - (a.confidence || 0);
      if (Math.abs(confDiff) > 0.1) return confDiff;

      // If confidence similar, prefer higher tier
      return (b.tier || 0) - (a.tier || 0);
    })[0];
  }

  /**
   * Estimate API cost for tier
   * @param {string} tier - Tier name
   * @returns {number} - Estimated cost in cents
   */
  estimateCost(tier) {
    const costs = {
      tier1: 0.1,  // Caption analysis only
      tier2: 0.5,  // Video URL analysis
      tier3: 2.0   // Frame extraction + analysis
    };
    return costs[tier] || 0;
  }

  /**
   * Finalize extraction result with metadata
   * @param {object} results - All extraction results
   * @returns {object} - Final result
   */
  finalizeResult(results) {
    const endTime = Date.now();
    results.metadata.processingTime = endTime - results.metadata.startTime;
    results.metadata.costEfficiency = results.selected.confidence / results.metadata.totalCost;

    console.log('[ProgressiveExtractor] === FINAL RESULT ===', {
      selectedTier: results.metadata.selectedTier,
      confidence: results.selected.confidence,
      tiersAttempted: results.metadata.tiersAttempted,
      processingTime: `${results.metadata.processingTime}ms`,
      totalCost: `$${results.metadata.totalCost.toFixed(2)}`,
      costEfficiency: results.metadata.costEfficiency.toFixed(2),
      reason: results.metadata.reason
    });

    // Return the selected result with metadata
    return {
      ...results.selected,
      extractionMetadata: results.metadata,
      allTierResults: {
        tier1: results.tier1 ? { confidence: results.tier1.confidence, success: results.tier1.success } : null,
        tier2: results.tier2 ? { confidence: results.tier2.confidence, success: results.tier2.success } : null,
        tier3: results.tier3 ? { confidence: results.tier3.confidence, success: results.tier3.success } : null
      }
    };
  }

  /**
   * Get extraction strategy based on source data
   * @param {object} sourceData - Instagram/Apify data
   * @returns {object} - Recommended strategy
   */
  recommendStrategy(sourceData) {
    const hasGoodCaption = sourceData.caption?.length > 100 &&
                          sourceData.caption.toLowerCase().includes('ingredient');
    const hasVideo = !!sourceData.videoUrl;
    const isLongVideo = sourceData.videoDuration > 30;
    const isPopular = sourceData.viewCount > 10000;

    let strategy = {
      recommendedMaxTier: 1,
      reasoning: [],
      estimatedConfidence: 0.5
    };

    if (hasGoodCaption) {
      strategy.reasoning.push('Good caption with ingredients');
      strategy.estimatedConfidence += 0.2;
    }

    if (hasVideo) {
      strategy.recommendedMaxTier = 2;
      strategy.reasoning.push('Video available for analysis');
      strategy.estimatedConfidence += 0.15;

      if (isLongVideo) {
        strategy.recommendedMaxTier = 3;
        strategy.reasoning.push('Long video suitable for frame extraction');
        strategy.estimatedConfidence += 0.1;
      }
    }

    if (isPopular) {
      strategy.reasoning.push('Popular content likely high quality');
      strategy.estimatedConfidence += 0.05;
    }

    strategy.estimatedConfidence = Math.min(strategy.estimatedConfidence, 0.95);

    console.log('[ProgressiveExtractor] Strategy recommendation:', strategy);
    return strategy;
  }
}

module.exports = ProgressiveExtractor;