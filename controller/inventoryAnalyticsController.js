const { createClient } = require('@supabase/supabase-js');
const jwt = require('jsonwebtoken');

// Initialize Supabase client function
const getSupabaseClient = () => {
  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseKey = process.env.SUPABASE_ANON_KEY;
  
  if (!supabaseUrl || !supabaseKey) {
    throw new Error('Supabase configuration missing');
  }
  
  return createClient(supabaseUrl, supabaseKey);
};

// JWT secret
const JWT_SECRET = process.env.JWT_SECRET || 'your-super-secret-jwt-key-change-in-production';

// Helper function to get user ID from request (now provided by auth middleware)
const getUserIdFromToken = (req) => {
  // The auth middleware adds the user to req.user
  if (!req.user || !req.user.id) {
    throw new Error('No authenticated user');
  }
  return req.user.id;
};

// Standard food cost estimates (per item/serving)
const FOOD_COST_ESTIMATES = {
  'protein': 4.50,
  'vegetable': 1.25,
  'fruit': 1.75,
  'dairy': 2.00,
  'grain': 0.85,
  'other': 1.50
};

const inventoryAnalyticsController = {
  // Debug endpoint to help diagnose analytics issues
  async debugAnalytics(req, res) {
    const requestId = Math.random().toString(36).substring(7);
    
    try {
      console.log(`\n🔍 ================ ANALYTICS DEBUG START ================`);
      console.log(`🔍 DEBUG REQUEST ID: ${requestId}`);
      
      // Step 1: Check authentication
      let userId;
      try {
        userId = getUserIdFromToken(req);
        console.log(`✅ [${requestId}] Authentication successful - User ID: ${userId}`);
      } catch (authError) {
        console.log(`❌ [${requestId}] Authentication failed:`, authError.message);
        return res.status(401).json({
          success: false,
          error: 'Authentication failed',
          details: authError.message,
          requestId: requestId
        });
      }
      
      const supabase = getSupabaseClient();
      
      // Step 2: Check for ANY fridge_items for this user
      console.log(`🔍 [${requestId}] Checking for ANY fridge_items for user...`);
      const { data: allItems, error: allItemsError } = await supabase
        .from('fridge_items')
        .select('id, item_name, quantity, category, delete_reason, deleted_at, created_at')
        .eq('user_id', userId)
        .order('created_at', { ascending: false })
        .limit(10);
      
      if (allItemsError) {
        console.log(`❌ [${requestId}] Error querying fridge_items:`, allItemsError);
      } else {
        console.log(`📦 [${requestId}] Found ${allItems?.length || 0} total fridge_items for user`);
        if (allItems?.length > 0) {
          console.log(`📦 [${requestId}] Recent items:`, allItems.slice(0, 3));
        }
      }
      
      // Step 3: Check for deleted items with delete_reason
      console.log(`🔍 [${requestId}] Checking for deleted items with delete_reason...`);
      const { data: deletedItems, error: deletedError } = await supabase
        .from('fridge_items')
        .select('id, item_name, quantity, category, delete_reason, deleted_at')
        .eq('user_id', userId)
        .not('deleted_at', 'is', null)
        .not('delete_reason', 'is', null)
        .order('deleted_at', { ascending: false })
        .limit(10);
      
      if (deletedError) {
        console.log(`❌ [${requestId}] Error querying deleted items:`, deletedError);
      } else {
        console.log(`🗑️ [${requestId}] Found ${deletedItems?.length || 0} deleted items with delete_reason`);
        if (deletedItems?.length > 0) {
          console.log(`🗑️ [${requestId}] Recent deletions:`, deletedItems.slice(0, 3));
        }
      }
      
      // Step 4: Check for ANY inventory_usage records
      console.log(`🔍 [${requestId}] Checking for inventory_usage records...`);
      const { data: usageRecords, error: usageError } = await supabase
        .from('inventory_usage')
        .select('id, amount_used, unit, usage_type, used_at, notes')
        .eq('user_id', userId)
        .order('used_at', { ascending: false })
        .limit(10);
      
      if (usageError) {
        console.log(`❌ [${requestId}] Error querying inventory_usage:`, usageError);
      } else {
        console.log(`📊 [${requestId}] Found ${usageRecords?.length || 0} inventory_usage records`);
        if (usageRecords?.length > 0) {
          console.log(`📊 [${requestId}] Recent usage:`, usageRecords.slice(0, 3));
        }
      }
      
      // Step 5: Check date range logic
      const days = parseInt(req.query.days) || 30;
      const now = new Date();
      const startDate = new Date(now.getTime() - (days * 24 * 60 * 60 * 1000));
      
      console.log(`📅 [${requestId}] Date range test (${days} days):`);
      console.log(`📅 [${requestId}]   Start: ${startDate.toISOString()}`);
      console.log(`📅 [${requestId}]   End: ${now.toISOString()}`);
      
      // Check recent deletions within date range
      const recentDeletions = deletedItems?.filter(item => {
        const deletedAt = new Date(item.deleted_at);
        return deletedAt >= startDate && deletedAt <= now;
      }) || [];
      
      console.log(`📅 [${requestId}] Recent deletions within ${days} days: ${recentDeletions.length}`);
      
      const debugResponse = {
        success: true,
        debug: {
          userId: userId,
          authentication: 'successful',
          totalFridgeItems: allItems?.length || 0,
          deletedItemsCount: deletedItems?.length || 0,
          inventoryUsageRecords: usageRecords?.length || 0,
          dateRange: {
            days: days,
            startDate: startDate.toISOString(),
            endDate: now.toISOString()
          },
          recentDeletionsInRange: recentDeletions.length,
          sampleData: {
            recentItems: allItems?.slice(0, 2) || [],
            recentDeletions: deletedItems?.slice(0, 2) || [],
            recentUsage: usageRecords?.slice(0, 2) || []
          }
        },
        requestId: requestId
      };
      
      res.json(debugResponse);
      console.log(`\n✅ [${requestId}] ============= DEBUG COMPLETE =============\n`);
      
    } catch (error) {
      console.error(`\n💥 [${requestId}] ========== DEBUG ERROR ==========`);
      console.error(`💥 [${requestId}] Error:`, error);
      console.error(`💥 [${requestId}] ====================================\n`);
      
      res.status(500).json({
        success: false,
        error: 'Debug failed',
        details: error.message,
        requestId: requestId
      });
    }
  },

  // Get comprehensive inventory usage analytics for authenticated user
  async getUsageAnalytics(req, res) {
    const requestId = Math.random().toString(36).substring(7);
    
    try {
      console.log(`\n📊 ================ INVENTORY ANALYTICS START ================`);
      console.log(`📊 REQUEST ID: ${requestId}`);
      
      const days = parseInt(req.query.days) || 30;
      const userId = getUserIdFromToken(req);
      
      console.log(`📊 [${requestId}] User ID: ${userId}, Days: ${days}`);
      
      const supabase = getSupabaseClient();
      
      // Calculate date ranges
      const now = new Date();
      const startDate = new Date(now.getTime() - (days * 24 * 60 * 60 * 1000));
      const previousStartDate = new Date(startDate.getTime() - (days * 24 * 60 * 60 * 1000));
      
      console.log(`📊 [${requestId}] Current period: ${startDate.toISOString()} to ${now.toISOString()}`);
      console.log(`📊 [${requestId}] Previous period: ${previousStartDate.toISOString()} to ${startDate.toISOString()}`);
      
      // Quick data check before calculations
      console.log(`📊 [${requestId}] === QUICK DATA CHECK ===`);
      const { data: quickCheck } = await supabase
        .from('fridge_items')
        .select('id, delete_reason, deleted_at')
        .eq('user_id', userId)
        .not('deleted_at', 'is', null)
        .limit(5);
      console.log(`📊 [${requestId}] Found ${quickCheck?.length || 0} deleted items for this user:`, quickCheck);
      
      // Run analytics calculations in parallel
      const [
        consumptionData,
        wastageData,
        categoryData,
        mostUsedData,
        previousConsumptionData,
        previousWastageData
      ] = await Promise.all([
        inventoryAnalyticsController.calculateConsumptionMetrics(supabase, userId, startDate, now),
        inventoryAnalyticsController.calculateWastageMetrics(supabase, userId, startDate, now),
        inventoryAnalyticsController.calculateCategoryBreakdown(supabase, userId, startDate, now),
        inventoryAnalyticsController.calculateMostUsedItems(supabase, userId, startDate, now),
        inventoryAnalyticsController.calculateConsumptionMetrics(supabase, userId, previousStartDate, startDate),
        inventoryAnalyticsController.calculateWastageMetrics(supabase, userId, previousStartDate, startDate)
      ]);
      
      // Calculate total items and usage percentage
      const totalItemsConsumed = consumptionData.totalItems;
      const totalItemsWasted = wastageData.totalItems;
      const totalItemsProcessed = totalItemsConsumed + totalItemsWasted;
      const usagePercentage = totalItemsProcessed > 0 
        ? Math.round((totalItemsConsumed / totalItemsProcessed) * 100) 
        : 0;
      
      // Calculate value saved (items consumed before expiry)
      const valueSaved = consumptionData.estimatedValue;
      
      // Previous period calculations
      const prevTotalConsumed = previousConsumptionData.totalItems;
      const prevTotalWasted = previousWastageData.totalItems;
      const prevTotalProcessed = prevTotalConsumed + prevTotalWasted;
      const prevUsagePercentage = prevTotalProcessed > 0 
        ? Math.round((prevTotalConsumed / prevTotalProcessed) * 100) 
        : 0;
      const prevValueSaved = previousConsumptionData.estimatedValue;
      
      const analyticsData = {
        itemsConsumed: totalItemsConsumed,
        itemsWasted: totalItemsWasted,
        valueSaved: valueSaved,
        usagePercentage: usagePercentage,
        previousPeriod: {
          itemsConsumed: prevTotalConsumed,
          itemsWasted: prevTotalWasted,
          valueSaved: prevValueSaved,
          usagePercentage: prevUsagePercentage
        },
        categoryBreakdown: categoryData,
        mostUsedItems: mostUsedData,
        period: {
          days: days,
          startDate: startDate.toISOString(),
          endDate: now.toISOString()
        }
      };
      
      console.log(`📊 [${requestId}] Analytics calculated:`, {
        consumed: totalItemsConsumed,
        wasted: totalItemsWasted,
        usage: `${usagePercentage}%`,
        value: `$${valueSaved.toFixed(2)}`,
        categories: Object.keys(categoryData).length,
        mostUsed: mostUsedData.length
      });
      
      res.json({
        success: true,
        data: analyticsData,
        requestId: requestId
      });
      
      console.log(`\n✅ [${requestId}] ============= INVENTORY ANALYTICS COMPLETE =============\n`);
      
    } catch (error) {
      console.error(`\n💥 [${requestId}] ========== INVENTORY ANALYTICS ERROR ==========`);
      console.error(`💥 [${requestId}] Error:`, error);
      console.error(`💥 [${requestId}] ===================================================\n`);
      
      const statusCode = error.message.includes('token') ? 401 : 500;
      
      res.status(statusCode).json({
        success: false,
        error: error.message.includes('token') ? 'Authentication required' : 'Failed to fetch analytics',
        requestId: requestId
      });
    }
  },

  // Calculate consumption metrics from BOTH inventory_usage AND manual deletions
  async calculateConsumptionMetrics(supabase, userId, startDate, endDate) {
    try {
      console.log(`\n🔍 ===== CONSUMPTION METRICS CALCULATION =====`);
      console.log(`🔍 User ID: ${userId}`);
      console.log(`🔍 Date Range: ${startDate.toISOString()} to ${endDate.toISOString()}`);
      
      // SOURCE 1: Get meal deduction records from inventory_usage table
      console.log(`🔍 Querying inventory_usage table for meal deductions...`);
      const { data: mealUsageData, error: mealUsageError } = await supabase
        .from('inventory_usage')
        .select(`
          amount_used,
          unit,
          item_id,
          fridge_items:item_id(category, item_name)
        `)
        .eq('user_id', userId)
        .gte('used_at', startDate.toISOString())
        .lt('used_at', endDate.toISOString())
        .eq('usage_type', 'meal');
      
      if (mealUsageError) {
        console.error('❌ Error querying inventory_usage:', mealUsageError);
        throw mealUsageError;
      }
      
      console.log(`🔍 Found ${mealUsageData?.length || 0} meal deduction records`);
      if (mealUsageData?.length > 0) {
        console.log(`🔍 Sample meal usage:`, mealUsageData.slice(0, 3));
      }
      
      // SOURCE 2: Get manual deletions from fridge_items (delete_reason = 'used_up')
      console.log(`🔍 Querying fridge_items table for manual used_up deletions...`);
      const { data: manualUsageData, error: manualUsageError } = await supabase
        .from('fridge_items')
        .select('quantity, category, item_name, delete_reason, deleted_at')
        .eq('user_id', userId)
        .eq('delete_reason', 'used_up')
        .gte('deleted_at', startDate.toISOString())
        .lt('deleted_at', endDate.toISOString());
      
      if (manualUsageError) {
        console.error('❌ Error querying fridge_items for manual deletions:', manualUsageError);
        throw manualUsageError;
      }
      
      console.log(`🔍 Found ${manualUsageData?.length || 0} manual used_up deletion records`);
      if (manualUsageData?.length > 0) {
        console.log(`🔍 Sample manual deletions:`, manualUsageData.slice(0, 3));
      }
      
      let totalItems = 0;
      let estimatedValue = 0;
      
      // Process meal deduction data
      for (const usage of mealUsageData || []) {
        const category = (usage.fridge_items?.category || 'other').toLowerCase();
        const itemCost = FOOD_COST_ESTIMATES[category] || FOOD_COST_ESTIMATES.other;
        const amount = parseFloat(usage.amount_used) || 0;
        
        totalItems += amount;
        estimatedValue += amount * itemCost;
        console.log(`📊 Meal usage: ${amount} ${usage.unit || 'units'} of ${usage.fridge_items?.item_name} (${category}) = $${(amount * itemCost).toFixed(2)}`);
      }
      
      // Process manual deletion data
      for (const deletion of manualUsageData || []) {
        const category = (deletion.category || 'other').toLowerCase();
        const itemCost = FOOD_COST_ESTIMATES[category] || FOOD_COST_ESTIMATES.other;
        const quantity = parseFloat(deletion.quantity) || 0;
        
        totalItems += quantity;
        estimatedValue += quantity * itemCost;
        console.log(`📊 Manual used_up: ${quantity} units of ${deletion.item_name} (${category}) = $${(quantity * itemCost).toFixed(2)}`);
      }
      
      console.log(`🔍 TOTAL CONSUMPTION CALCULATED:`);
      console.log(`🔍   Total Items: ${totalItems}`);
      console.log(`🔍   Estimated Value: $${estimatedValue.toFixed(2)}`);
      console.log(`🔍   From meal deductions: ${mealUsageData?.length || 0} records`);
      console.log(`🔍   From manual deletions: ${manualUsageData?.length || 0} records`);
      console.log(`🔍 ===============================================\n`);
      
      return {
        totalItems: Math.round(totalItems * 100) / 100, // Round to 2 decimal places
        estimatedValue: Math.round(estimatedValue * 100) / 100
      };
      
    } catch (error) {
      console.error('❌ Error calculating consumption metrics:', error);
      return { totalItems: 0, estimatedValue: 0 };
    }
  },

  // Calculate wastage metrics from soft-deleted items
  async calculateWastageMetrics(supabase, userId, startDate, endDate) {
    try {
      console.log(`\n🗑️ ===== WASTAGE METRICS CALCULATION =====`);
      console.log(`🗑️ User ID: ${userId}`);
      console.log(`🗑️ Date Range: ${startDate.toISOString()} to ${endDate.toISOString()}`);
      
      const { data: wastedItems, error } = await supabase
        .from('fridge_items')
        .select('quantity, category, item_name, delete_reason, deleted_at')
        .eq('user_id', userId)
        .eq('delete_reason', 'thrown_away')
        .gte('deleted_at', startDate.toISOString())
        .lt('deleted_at', endDate.toISOString());
      
      if (error) {
        console.error('❌ Error querying fridge_items for waste:', error);
        throw error;
      }
      
      console.log(`🗑️ Found ${wastedItems?.length || 0} thrown_away deletion records`);
      if (wastedItems?.length > 0) {
        console.log(`🗑️ Sample wasted items:`, wastedItems.slice(0, 3));
      }
      
      let totalItems = 0;
      let estimatedValue = 0;
      
      for (const item of wastedItems || []) {
        const category = (item.category || 'other').toLowerCase();
        const itemCost = FOOD_COST_ESTIMATES[category] || FOOD_COST_ESTIMATES.other;
        const quantity = parseFloat(item.quantity) || 0;
        
        totalItems += quantity;
        estimatedValue += quantity * itemCost;
        console.log(`🗑️ Wasted: ${quantity} units of ${item.item_name} (${category}) = $${(quantity * itemCost).toFixed(2)}`);
      }
      
      console.log(`🗑️ TOTAL WASTAGE CALCULATED:`);
      console.log(`🗑️   Total Items: ${totalItems}`);
      console.log(`🗑️   Estimated Value: $${estimatedValue.toFixed(2)}`);
      console.log(`🗑️   From thrown_away deletions: ${wastedItems?.length || 0} records`);
      console.log(`🗑️ =============================================\n`);
      
      return {
        totalItems: Math.round(totalItems * 100) / 100,
        estimatedValue: Math.round(estimatedValue * 100) / 100
      };
      
    } catch (error) {
      console.error('❌ Error calculating wastage metrics:', error);
      return { totalItems: 0, estimatedValue: 0 };
    }
  },

  // Calculate category breakdown from BOTH usage data AND manual deletions
  async calculateCategoryBreakdown(supabase, userId, startDate, endDate) {
    try {
      console.log(`\n📊 ===== CATEGORY BREAKDOWN CALCULATION =====`);
      
      // Get meal usage data
      const { data: mealUsageData, error: mealError } = await supabase
        .from('inventory_usage')
        .select(`
          amount_used,
          item_id,
          fridge_items:item_id(category)
        `)
        .eq('user_id', userId)
        .gte('used_at', startDate.toISOString())
        .lt('used_at', endDate.toISOString())
        .eq('usage_type', 'meal');
      
      if (mealError) throw mealError;
      
      // Get manual usage data (used_up deletions)
      const { data: manualUsageData, error: manualError } = await supabase
        .from('fridge_items')
        .select('quantity, category')
        .eq('user_id', userId)
        .eq('delete_reason', 'used_up')
        .gte('deleted_at', startDate.toISOString())
        .lt('deleted_at', endDate.toISOString());
      
      if (manualError) throw manualError;
      
      console.log(`📊 Meal usage records for categories: ${mealUsageData?.length || 0}`);
      console.log(`📊 Manual deletion records for categories: ${manualUsageData?.length || 0}`);
      
      const categoryTotals = {};
      let grandTotal = 0;
      
      // Process meal usage data
      for (const usage of mealUsageData || []) {
        const category = usage.fridge_items?.category || 'Other';
        const amount = parseFloat(usage.amount_used) || 0;
        
        categoryTotals[category] = (categoryTotals[category] || 0) + amount;
        grandTotal += amount;
      }
      
      // Process manual deletion data
      for (const deletion of manualUsageData || []) {
        const category = deletion.category || 'Other';
        const quantity = parseFloat(deletion.quantity) || 0;
        
        categoryTotals[category] = (categoryTotals[category] || 0) + quantity;
        grandTotal += quantity;
      }
      
      console.log(`📊 Category totals:`, categoryTotals);
      console.log(`📊 Grand total: ${grandTotal}`);
      
      // Convert to percentages
      const categoryPercentages = {};
      for (const [category, total] of Object.entries(categoryTotals)) {
        const percentage = grandTotal > 0 ? Math.round((total / grandTotal) * 100) : 0;
        categoryPercentages[category] = percentage;
      }
      
      console.log(`📊 Category percentages:`, categoryPercentages);
      console.log(`📊 =========================================\n`);
      
      return categoryPercentages;
      
    } catch (error) {
      console.error('❌ Error calculating category breakdown:', error);
      return {};
    }
  },

  // Calculate most used items from BOTH usage patterns AND manual deletions
  async calculateMostUsedItems(supabase, userId, startDate, endDate) {
    try {
      console.log(`\n⭐ ===== MOST USED ITEMS CALCULATION =====`);
      
      // Get meal usage data
      const { data: mealUsageData, error: mealError } = await supabase
        .from('inventory_usage')
        .select(`
          amount_used,
          used_at,
          item_id,
          fridge_items:item_id(item_name)
        `)
        .eq('user_id', userId)
        .gte('used_at', startDate.toISOString())
        .lt('used_at', endDate.toISOString())
        .eq('usage_type', 'meal')
        .order('used_at', { ascending: false });
      
      if (mealError) throw mealError;
      
      // Get manual deletion data (used_up)
      const { data: manualUsageData, error: manualError } = await supabase
        .from('fridge_items')
        .select('quantity, item_name, deleted_at')
        .eq('user_id', userId)
        .eq('delete_reason', 'used_up')
        .gte('deleted_at', startDate.toISOString())
        .lt('deleted_at', endDate.toISOString())
        .order('deleted_at', { ascending: false });
      
      if (manualError) throw manualError;
      
      console.log(`⭐ Meal usage records for most used: ${mealUsageData?.length || 0}`);
      console.log(`⭐ Manual deletion records for most used: ${manualUsageData?.length || 0}`);
      
      const itemStats = {};
      
      // Process meal usage data
      for (const usage of mealUsageData || []) {
        const itemName = usage.fridge_items?.item_name;
        if (!itemName) continue;
        
        if (!itemStats[itemName]) {
          itemStats[itemName] = {
            count: 0,
            totalAmount: 0,
            dates: []
          };
        }
        
        itemStats[itemName].count += 1;
        itemStats[itemName].totalAmount += parseFloat(usage.amount_used) || 0;
        itemStats[itemName].dates.push(new Date(usage.used_at));
      }
      
      // Process manual deletion data
      for (const deletion of manualUsageData || []) {
        const itemName = deletion.item_name;
        if (!itemName) continue;
        
        if (!itemStats[itemName]) {
          itemStats[itemName] = {
            count: 0,
            totalAmount: 0,
            dates: []
          };
        }
        
        itemStats[itemName].count += 1;
        itemStats[itemName].totalAmount += parseFloat(deletion.quantity) || 0;
        itemStats[itemName].dates.push(new Date(deletion.deleted_at));
      }
      
      console.log(`⭐ Item stats collected for ${Object.keys(itemStats).length} unique items`);
      
      // Calculate average days between usage and sort by frequency
      const itemsWithStats = Object.entries(itemStats)
        .map(([itemName, stats]) => {
          let avgDays = 0;
          if (stats.dates.length > 1) {
            const sortedDates = stats.dates.sort((a, b) => a - b);
            let totalDaysBetween = 0;
            for (let i = 1; i < sortedDates.length; i++) {
              totalDaysBetween += (sortedDates[i] - sortedDates[i-1]) / (1000 * 60 * 60 * 24);
            }
            avgDays = Math.round(totalDaysBetween / (sortedDates.length - 1));
          }
          
          return {
            itemName,
            count: stats.count,
            avgDays: avgDays || 0
          };
        })
        .sort((a, b) => b.count - a.count)
        .slice(0, 5); // Top 5 most used items
      
      console.log(`⭐ Top 5 most used items:`, itemsWithStats);
      console.log(`⭐ =====================================\n`);
      
      return itemsWithStats;
      
    } catch (error) {
      console.error('❌ Error calculating most used items:', error);
      return [];
    }
  }
};

module.exports = inventoryAnalyticsController;