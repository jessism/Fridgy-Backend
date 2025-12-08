const { createClient } = require('@supabase/supabase-js');

// Helper function to get Supabase client
const getSupabaseClient = () => {
  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseKey = process.env.SUPABASE_ANON_KEY;

  if (!supabaseUrl || !supabaseKey) {
    throw new Error('Supabase configuration missing');
  }

  return createClient(supabaseUrl, supabaseKey);
};

const cookbooksController = {

  // Get all cookbooks for user with recipe counts
  async getCookbooks(req, res) {
    const requestId = Math.random().toString(36).substring(7);

    try {
      console.log(`\n[${requestId}] GET COOKBOOKS START`);

      const userId = req.user.id;
      const supabase = getSupabaseClient();

      // Fetch user's cookbooks
      const { data: cookbooks, error } = await supabase
        .from('cookbooks')
        .select('*')
        .eq('user_id', userId)
        .order('created_at', { ascending: false });

      if (error) throw error;

      // Get recipe counts and first recipe image for each cookbook
      const cookbooksWithDetails = await Promise.all(
        (cookbooks || []).map(async (cookbook) => {
          // Get recipes in this cookbook
          const { data: cookbookRecipes, error: recipesError } = await supabase
            .from('cookbook_recipes')
            .select('recipe_id, recipe_source')
            .eq('cookbook_id', cookbook.id)
            .order('position', { ascending: true });

          if (recipesError) {
            console.error(`[${requestId}] Error fetching cookbook recipes:`, recipesError);
            return { ...cookbook, recipe_count: 0, cover_image: null };
          }

          // Get up to 3 recipe images for preview collage
          let previewImages = [];
          if (cookbookRecipes && cookbookRecipes.length > 0) {
            const recipesToFetch = cookbookRecipes.slice(0, 3);
            const imagePromises = recipesToFetch.map(async (cr) => {
              const { data: recipe } = await supabase
                .from('saved_recipes')
                .select('image')
                .eq('id', cr.recipe_id)
                .single();
              return recipe?.image || null;
            });
            const images = await Promise.all(imagePromises);
            previewImages = images.filter(img => img !== null);
          }

          return {
            ...cookbook,
            recipe_count: cookbookRecipes?.length || 0,
            cover_image: previewImages[0] || null, // Keep for backward compatibility
            preview_images: previewImages
          };
        })
      );

      console.log(`[${requestId}] Cookbooks retrieved: ${cookbooksWithDetails.length}`);
      res.json({ success: true, cookbooks: cookbooksWithDetails });

    } catch (error) {
      console.error(`[${requestId}] Error:`, error.message);
      res.status(500).json({ success: false, error: error.message, requestId });
    }
  },

  // Get specific cookbook with its recipes
  async getCookbookById(req, res) {
    const requestId = Math.random().toString(36).substring(7);

    try {
      const { id } = req.params;
      const userId = req.user.id;
      const supabase = getSupabaseClient();

      // Get cookbook
      const { data: cookbook, error } = await supabase
        .from('cookbooks')
        .select('*')
        .eq('id', id)
        .eq('user_id', userId)
        .single();

      if (error || !cookbook) {
        return res.status(404).json({ success: false, error: 'Cookbook not found', requestId });
      }

      // Get recipes in this cookbook
      const { data: cookbookRecipes, error: recipesError } = await supabase
        .from('cookbook_recipes')
        .select('recipe_id, recipe_source, position, added_at')
        .eq('cookbook_id', id)
        .order('position', { ascending: true });

      if (recipesError) throw recipesError;

      // Fetch full recipe data for each
      const recipes = await Promise.all(
        (cookbookRecipes || []).map(async (cr) => {
          const { data: recipe } = await supabase
            .from('saved_recipes')
            .select('*')
            .eq('id', cr.recipe_id)
            .single();

          return recipe ? { ...recipe, cookbook_position: cr.position, added_at: cr.added_at } : null;
        })
      );

      // Filter out any null recipes (deleted recipes)
      const validRecipes = recipes.filter(r => r !== null);

      res.json({
        success: true,
        cookbook: {
          ...cookbook,
          recipes: validRecipes,
          recipe_count: validRecipes.length
        }
      });

    } catch (error) {
      console.error(`[${requestId}] Error:`, error.message);
      res.status(500).json({ success: false, error: error.message, requestId });
    }
  },

  // Create new cookbook
  async createCookbook(req, res) {
    const requestId = Math.random().toString(36).substring(7);

    try {
      const { name, description } = req.body;
      const userId = req.user.id;

      if (!name || !name.trim()) {
        return res.status(400).json({ success: false, error: 'Cookbook name is required', requestId });
      }

      const supabase = getSupabaseClient();

      const { data: cookbook, error } = await supabase
        .from('cookbooks')
        .insert([{
          user_id: userId,
          name: name.trim(),
          description: description?.trim() || null,
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString()
        }])
        .select('*')
        .single();

      if (error) throw error;

      console.log(`[${requestId}] Cookbook created:`, cookbook.id);
      res.json({ success: true, cookbook: { ...cookbook, recipe_count: 0 } });

    } catch (error) {
      console.error(`[${requestId}] Error:`, error.message);
      res.status(500).json({ success: false, error: error.message, requestId });
    }
  },

  // Update cookbook
  async updateCookbook(req, res) {
    const requestId = Math.random().toString(36).substring(7);

    try {
      const { id } = req.params;
      const { name, description } = req.body;
      const userId = req.user.id;
      const supabase = getSupabaseClient();

      // Verify ownership
      const { data: existing } = await supabase
        .from('cookbooks')
        .select('id')
        .eq('id', id)
        .eq('user_id', userId)
        .single();

      if (!existing) {
        return res.status(403).json({ success: false, error: 'Not authorized', requestId });
      }

      const updateData = { updated_at: new Date().toISOString() };
      if (name !== undefined) updateData.name = name.trim();
      if (description !== undefined) updateData.description = description?.trim() || null;

      const { data: cookbook, error } = await supabase
        .from('cookbooks')
        .update(updateData)
        .eq('id', id)
        .select('*')
        .single();

      if (error) throw error;

      res.json({ success: true, cookbook });

    } catch (error) {
      console.error(`[${requestId}] Error:`, error.message);
      res.status(500).json({ success: false, error: error.message, requestId });
    }
  },

  // Delete cookbook
  async deleteCookbook(req, res) {
    const requestId = Math.random().toString(36).substring(7);

    try {
      const { id } = req.params;
      const userId = req.user.id;
      const supabase = getSupabaseClient();

      // Verify ownership
      const { data: existing } = await supabase
        .from('cookbooks')
        .select('id')
        .eq('id', id)
        .eq('user_id', userId)
        .single();

      if (!existing) {
        return res.status(403).json({ success: false, error: 'Not authorized', requestId });
      }

      // Delete cookbook (cookbook_recipes will cascade delete)
      const { error } = await supabase
        .from('cookbooks')
        .delete()
        .eq('id', id);

      if (error) throw error;

      console.log(`[${requestId}] Cookbook deleted:`, id);
      res.json({ success: true, message: 'Cookbook deleted', requestId });

    } catch (error) {
      console.error(`[${requestId}] Error:`, error.message);
      res.status(500).json({ success: false, error: error.message, requestId });
    }
  },

  // Add recipes to cookbook
  async addRecipes(req, res) {
    const requestId = Math.random().toString(36).substring(7);

    try {
      const { id } = req.params;
      const { recipes } = req.body; // Array of { recipe_id, recipe_source }
      const userId = req.user.id;
      const supabase = getSupabaseClient();

      if (!recipes || !Array.isArray(recipes) || recipes.length === 0) {
        return res.status(400).json({ success: false, error: 'Recipes array is required', requestId });
      }

      // Verify cookbook ownership
      const { data: cookbook } = await supabase
        .from('cookbooks')
        .select('id')
        .eq('id', id)
        .eq('user_id', userId)
        .single();

      if (!cookbook) {
        return res.status(403).json({ success: false, error: 'Not authorized', requestId });
      }

      // Get current max position
      const { data: existingRecipes } = await supabase
        .from('cookbook_recipes')
        .select('position')
        .eq('cookbook_id', id)
        .order('position', { ascending: false })
        .limit(1);

      let nextPosition = (existingRecipes?.[0]?.position || 0) + 1;

      // Prepare inserts
      const inserts = recipes.map((r, index) => ({
        cookbook_id: id,
        recipe_id: r.recipe_id,
        recipe_source: r.recipe_source || 'saved',
        position: nextPosition + index,
        added_at: new Date().toISOString()
      }));

      // Insert recipes (ignore duplicates)
      const { data: added, error } = await supabase
        .from('cookbook_recipes')
        .upsert(inserts, { onConflict: 'cookbook_id,recipe_id,recipe_source', ignoreDuplicates: true })
        .select('*');

      if (error) throw error;

      // Update cookbook's updated_at
      await supabase
        .from('cookbooks')
        .update({ updated_at: new Date().toISOString() })
        .eq('id', id);

      console.log(`[${requestId}] Added ${added?.length || 0} recipes to cookbook ${id}`);
      res.json({ success: true, added: added?.length || 0 });

    } catch (error) {
      console.error(`[${requestId}] Error:`, error.message);
      res.status(500).json({ success: false, error: error.message, requestId });
    }
  },

  // Remove recipe from cookbook
  async removeRecipe(req, res) {
    const requestId = Math.random().toString(36).substring(7);

    try {
      const { id, recipeId } = req.params;
      const { recipe_source } = req.query;
      const userId = req.user.id;
      const supabase = getSupabaseClient();

      // Verify cookbook ownership
      const { data: cookbook } = await supabase
        .from('cookbooks')
        .select('id')
        .eq('id', id)
        .eq('user_id', userId)
        .single();

      if (!cookbook) {
        return res.status(403).json({ success: false, error: 'Not authorized', requestId });
      }

      // Build delete query
      let query = supabase
        .from('cookbook_recipes')
        .delete()
        .eq('cookbook_id', id)
        .eq('recipe_id', recipeId);

      if (recipe_source) {
        query = query.eq('recipe_source', recipe_source);
      }

      const { error } = await query;

      if (error) throw error;

      // Update cookbook's updated_at
      await supabase
        .from('cookbooks')
        .update({ updated_at: new Date().toISOString() })
        .eq('id', id);

      console.log(`[${requestId}] Removed recipe ${recipeId} from cookbook ${id}`);
      res.json({ success: true, message: 'Recipe removed from cookbook', requestId });

    } catch (error) {
      console.error(`[${requestId}] Error:`, error.message);
      res.status(500).json({ success: false, error: error.message, requestId });
    }
  },

  // ============================================
  // Sharing Methods
  // ============================================

  // Generate share code helper
  _generateShareCode() {
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // No I, O, 0, 1 for clarity
    let code = '';
    for (let i = 0; i < 8; i++) {
      if (i === 4) code += '-';
      code += chars[Math.floor(Math.random() * chars.length)];
    }
    return code;
  },

  // Generate or get share code for a cookbook
  async generateShareCode(req, res) {
    const requestId = Math.random().toString(36).substring(7);

    try {
      const { id } = req.params;
      const userId = req.user.id;
      const supabase = getSupabaseClient();

      // Get cookbook and verify ownership
      const { data: cookbook, error } = await supabase
        .from('cookbooks')
        .select('*, cookbook_members(user_id, role)')
        .eq('id', id)
        .single();

      if (error || !cookbook) {
        return res.status(404).json({ success: false, error: 'Cookbook not found', requestId });
      }

      // Check if user is owner (check user_id first for backward compatibility, then members table)
      const isOwner = cookbook.user_id === userId ||
        (cookbook.cookbook_members || []).some(m => m.user_id === userId && m.role === 'owner');
      if (!isOwner) {
        return res.status(403).json({ success: false, error: 'Only the owner can share this cookbook', requestId });
      }

      // Generate new code if none exists
      let shareCode = cookbook.share_code;
      if (!shareCode) {
        // Generate unique code
        let attempts = 0;
        while (attempts < 10) {
          shareCode = cookbooksController._generateShareCode();
          const { data: existing } = await supabase
            .from('cookbooks')
            .select('id')
            .eq('share_code', shareCode)
            .single();

          if (!existing) break;
          attempts++;
        }

        // Update cookbook with share code
        const { error: updateError } = await supabase
          .from('cookbooks')
          .update({ share_code: shareCode })
          .eq('id', id);

        if (updateError) throw updateError;
      }

      // Build share link
      const baseUrl = process.env.FRONTEND_URL || 'https://app.trackabite.com';
      const shareLink = `${baseUrl}/join/cookbook/${shareCode}`;

      console.log(`[${requestId}] Share code generated for cookbook ${id}: ${shareCode}`);
      res.json({
        success: true,
        shareCode,
        shareLink,
        cookbookName: cookbook.name
      });

    } catch (error) {
      console.error(`[${requestId}] Error generating share code:`, error.message);
      res.status(500).json({ success: false, error: error.message, requestId });
    }
  },

  // Join a cookbook via share code
  async joinCookbook(req, res) {
    const requestId = Math.random().toString(36).substring(7);

    try {
      const { shareCode } = req.params;
      const userId = req.user.id;
      const supabase = getSupabaseClient();

      // Find cookbook by share code
      const { data: cookbook, error } = await supabase
        .from('cookbooks')
        .select('id, name, user_id')
        .eq('share_code', shareCode.toUpperCase())
        .single();

      if (error || !cookbook) {
        return res.status(404).json({
          success: false,
          error: 'Invalid share code. Please check and try again.',
          requestId
        });
      }

      // Check if already a member
      const { data: existingMember } = await supabase
        .from('cookbook_members')
        .select('id, role')
        .eq('cookbook_id', cookbook.id)
        .eq('user_id', userId)
        .single();

      if (existingMember) {
        // Already a member - return success (idempotent)
        return res.json({
          success: true,
          message: 'You already have access to this cookbook',
          cookbook: { id: cookbook.id, name: cookbook.name },
          alreadyMember: true
        });
      }

      // Check usage limits for joined cookbooks (free tier: 1)
      const usageService = require('../services/usageService');
      const limitCheck = await usageService.checkLimit(userId, 'joined_cookbooks');

      if (!limitCheck.allowed) {
        return res.status(402).json({
          error: 'LIMIT_EXCEEDED',
          message: `You've reached your ${limitCheck.tier} tier limit for joined cookbooks`,
          current: limitCheck.current,
          limit: limitCheck.limit,
          tier: limitCheck.tier,
          upgradeRequired: true,
          feature: 'joined_cookbooks'
        });
      }

      // Get inviter's name
      const { data: inviter } = await supabase
        .from('users')
        .select('first_name, email')
        .eq('id', cookbook.user_id)
        .single();

      const inviterName = inviter?.first_name || inviter?.email?.split('@')[0] || 'Unknown';

      // Add user as member
      const { error: insertError } = await supabase
        .from('cookbook_members')
        .insert({
          cookbook_id: cookbook.id,
          user_id: userId,
          role: 'member',
          invited_by: cookbook.user_id,
          invited_by_name: inviterName,
          joined_at: new Date().toISOString()
        });

      if (insertError) throw insertError;

      // Increment usage counter
      await usageService.incrementUsage(userId, 'joined_cookbooks');

      console.log(`[${requestId}] User ${userId} joined cookbook ${cookbook.id}`);
      res.json({
        success: true,
        message: 'Successfully joined cookbook',
        cookbook: { id: cookbook.id, name: cookbook.name }
      });

    } catch (error) {
      console.error(`[${requestId}] Error joining cookbook:`, error.message);
      res.status(500).json({ success: false, error: error.message, requestId });
    }
  },

  // Get members of a cookbook
  async getMembers(req, res) {
    const requestId = Math.random().toString(36).substring(7);

    try {
      const { id } = req.params;
      const userId = req.user.id;
      const supabase = getSupabaseClient();

      // Check if user has access to this cookbook
      const { data: membership } = await supabase
        .from('cookbook_members')
        .select('role')
        .eq('cookbook_id', id)
        .eq('user_id', userId)
        .single();

      // Also check if user is the original owner (backward compatibility)
      const { data: cookbook } = await supabase
        .from('cookbooks')
        .select('user_id')
        .eq('id', id)
        .single();

      if (!membership && cookbook?.user_id !== userId) {
        return res.status(403).json({ success: false, error: 'Not authorized', requestId });
      }

      // Get all members with user info
      const { data: members, error } = await supabase
        .from('cookbook_members')
        .select(`
          id,
          user_id,
          role,
          joined_at,
          invited_by_name,
          users:user_id (
            first_name,
            email
          )
        `)
        .eq('cookbook_id', id)
        .order('joined_at', { ascending: true });

      if (error) throw error;

      // Format members
      const formattedMembers = (members || []).map(m => ({
        id: m.id,
        userId: m.user_id,
        role: m.role,
        joinedAt: m.joined_at,
        invitedBy: m.invited_by_name,
        name: m.users?.first_name || m.users?.email?.split('@')[0] || 'Unknown',
        email: m.users?.email
      }));

      res.json({ success: true, members: formattedMembers });

    } catch (error) {
      console.error(`[${requestId}] Error getting members:`, error.message);
      res.status(500).json({ success: false, error: error.message, requestId });
    }
  },

  // Remove a member from cookbook
  async removeMember(req, res) {
    const requestId = Math.random().toString(36).substring(7);

    try {
      const { id, memberId } = req.params;
      const userId = req.user.id;
      const supabase = getSupabaseClient();

      // Check if requester is owner
      const { data: requesterMembership } = await supabase
        .from('cookbook_members')
        .select('role')
        .eq('cookbook_id', id)
        .eq('user_id', userId)
        .single();

      // Also check original owner
      const { data: cookbook } = await supabase
        .from('cookbooks')
        .select('user_id')
        .eq('id', id)
        .single();

      const isOwner = requesterMembership?.role === 'owner' || cookbook?.user_id === userId;

      if (!isOwner) {
        return res.status(403).json({ success: false, error: 'Only the owner can remove members', requestId });
      }

      // Get member to remove
      const { data: memberToRemove } = await supabase
        .from('cookbook_members')
        .select('user_id, role')
        .eq('id', memberId)
        .eq('cookbook_id', id)
        .single();

      if (!memberToRemove) {
        return res.status(404).json({ success: false, error: 'Member not found', requestId });
      }

      // Can't remove the owner
      if (memberToRemove.role === 'owner') {
        return res.status(400).json({ success: false, error: 'Cannot remove the cookbook owner', requestId });
      }

      // Remove member
      const { error } = await supabase
        .from('cookbook_members')
        .delete()
        .eq('id', memberId);

      if (error) throw error;

      // Decrement usage counter for the removed user
      const usageService = require('../services/usageService');
      await usageService.decrementUsage(memberToRemove.user_id, 'joined_cookbooks');

      console.log(`[${requestId}] Member ${memberId} removed from cookbook ${id}`);
      res.json({ success: true, message: 'Member removed' });

    } catch (error) {
      console.error(`[${requestId}] Error removing member:`, error.message);
      res.status(500).json({ success: false, error: error.message, requestId });
    }
  },

  // Leave a cookbook (self-removal)
  async leaveCookbook(req, res) {
    const requestId = Math.random().toString(36).substring(7);

    try {
      const { id } = req.params;
      const userId = req.user.id;
      const supabase = getSupabaseClient();

      // Get user's membership
      const { data: membership } = await supabase
        .from('cookbook_members')
        .select('id, role')
        .eq('cookbook_id', id)
        .eq('user_id', userId)
        .single();

      if (!membership) {
        return res.status(404).json({ success: false, error: 'You are not a member of this cookbook', requestId });
      }

      // Owner can't leave (must delete cookbook instead)
      if (membership.role === 'owner') {
        return res.status(400).json({
          success: false,
          error: 'Owners cannot leave their cookbook. Delete the cookbook instead.',
          requestId
        });
      }

      // Remove membership
      const { error } = await supabase
        .from('cookbook_members')
        .delete()
        .eq('id', membership.id);

      if (error) throw error;

      // Decrement usage counter
      const usageService = require('../services/usageService');
      await usageService.decrementUsage(userId, 'joined_cookbooks');

      console.log(`[${requestId}] User ${userId} left cookbook ${id}`);
      res.json({ success: true, message: 'Successfully left cookbook' });

    } catch (error) {
      console.error(`[${requestId}] Error leaving cookbook:`, error.message);
      res.status(500).json({ success: false, error: error.message, requestId });
    }
  },

  // Health check
  async healthCheck(req, res) {
    try {
      const hasSupabase = !!process.env.SUPABASE_URL && !!process.env.SUPABASE_ANON_KEY;
      res.json({
        success: true,
        service: 'Cookbooks Service',
        status: hasSupabase ? 'ready' : 'configuration_required',
        timestamp: new Date().toISOString()
      });
    } catch (error) {
      res.status(500).json({ success: false, error: error.message });
    }
  }
};

module.exports = cookbooksController;
