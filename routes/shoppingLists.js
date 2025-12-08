const express = require('express');
const router = express.Router();
const { createClient } = require('@supabase/supabase-js');
const authMiddleware = require('../middleware/auth');
const { checkShoppingListLimit, checkJoinedListLimit, incrementUsageCounter, decrementUsageCounter } = require('../middleware/checkLimits');
const categoryService = require('../services/categoryService');

// Initialize Supabase
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_ANON_KEY
);

// Helper: Generate share code
const generateShareCode = () => {
  const part1 = Math.random().toString(36).substring(2, 6).toUpperCase();
  const part2 = Math.random().toString(36).substring(2, 6).toUpperCase();
  return `${part1}-${part2}`;
};

// Helper: Check if user can modify list
const canUserModifyList = async (userId, listId) => {
  const { data } = await supabase
    .from('shopping_list_members')
    .select('role')
    .eq('user_id', userId)
    .eq('list_id', listId)
    .single();

  return data !== null;
};

// GET /api/shopping-lists - Get all lists for user
router.get('/', authMiddleware.authenticateToken, async (req, res) => {
  try {
    const userId = req.user.id;

    // Get lists where user is owner or member
    const { data: memberLists } = await supabase
      .from('shopping_list_members')
      .select('list_id')
      .eq('user_id', userId);

    const listIds = memberLists?.map(m => m.list_id) || [];

    if (listIds.length === 0) {
      return res.json({ lists: [] });
    }

    // Get full list details with item counts
    const { data: lists, error } = await supabase
      .from('shopping_lists')
      .select(`
        *,
        shopping_list_items(id, is_checked),
        shopping_list_members(user_id, role)
      `)
      .in('id', listIds)
      .eq('is_archived', false)
      .order('created_at', { ascending: false });

    if (error) throw error;

    // Format response with counts
    const formattedLists = lists.map(list => ({
      ...list,
      total_items: list.shopping_list_items?.length || 0,
      checked_items: list.shopping_list_items?.filter(i => i.is_checked).length || 0,
      member_count: list.shopping_list_members?.length || 0,
      is_owner: list.owner_id === userId
    }));

    res.json({ lists: formattedLists });
  } catch (error) {
    console.error('Error fetching lists:', error);
    res.status(500).json({ error: 'Failed to fetch shopping lists' });
  }
});

// POST /api/shopping-lists - Create new list
router.post('/', authMiddleware.authenticateToken, checkShoppingListLimit, async (req, res) => {
  try {
    const { name, color, items } = req.body;
    const userId = req.user.id;
    const userName = `${req.user.firstName || ''}`.trim() || req.user.email;

    // Generate unique share code
    let shareCode;
    let codeIsUnique = false;
    while (!codeIsUnique) {
      shareCode = generateShareCode();
      const { data: existing } = await supabase
        .from('shopping_lists')
        .select('id')
        .eq('share_code', shareCode)
        .single();
      codeIsUnique = !existing;
    }

    // Create list
    const { data: list, error: listError } = await supabase
      .from('shopping_lists')
      .insert({
        name,
        color: color || '#c3f0ca',
        owner_id: userId,
        share_code: shareCode
      })
      .select()
      .single();

    if (listError) throw listError;

    // Add owner as member
    await supabase
      .from('shopping_list_members')
      .insert({
        list_id: list.id,
        user_id: userId,
        role: 'owner',
        invited_by_name: userName
      });

    // Add initial items if provided
    if (items && items.length > 0) {
      const itemsToInsert = items.map((item, index) => ({
        list_id: list.id,
        name: item.name,
        quantity: item.quantity,
        unit: item.unit,
        category: item.category || 'Other',
        added_by: userId,
        added_by_name: userName,
        order_index: index,
        is_checked: item.checked || false
      }));

      await supabase
        .from('shopping_list_items')
        .insert(itemsToInsert);
    }

    // Increment usage counter for owned lists
    await incrementUsageCounter(userId, 'owned_shopping_lists');
    console.log('[ShoppingLists] Usage counter incremented for owned list');

    res.json({ success: true, list });
  } catch (error) {
    console.error('Error creating list:', error);
    res.status(500).json({ error: 'Failed to create shopping list' });
  }
});

// GET /api/shopping-lists/:id - Get single list with items
router.get('/:id', authMiddleware.authenticateToken, async (req, res) => {
  try {
    const { id } = req.params;
    const userId = req.user.id;

    // Check if user has access
    const hasAccess = await canUserModifyList(userId, id);
    if (!hasAccess) {
      return res.status(403).json({ error: 'Access denied' });
    }

    // Get list with items and members
    const { data: list, error } = await supabase
      .from('shopping_lists')
      .select(`
        *,
        shopping_list_items(*),
        shopping_list_members(*)
      `)
      .eq('id', id)
      .single();

    if (error) throw error;

    // Get member details
    if (list.shopping_list_members && list.shopping_list_members.length > 0) {
      const memberIds = list.shopping_list_members.map(m => m.user_id);
      const { data: users } = await supabase
        .from('users')
        .select('id, first_name, email')
        .in('id', memberIds);

      list.shopping_list_members = list.shopping_list_members.map(member => {
        const user = users?.find(u => u.id === member.user_id);
        return {
          ...member,
          user
        };
      });
    }

    // Sort items by order_index
    if (list.shopping_list_items) {
      list.shopping_list_items.sort((a, b) => a.order_index - b.order_index);
    }

    res.json({ list });
  } catch (error) {
    console.error('Error fetching list:', error);
    res.status(500).json({ error: 'Failed to fetch shopping list' });
  }
});

// PUT /api/shopping-lists/:id - Update list
router.put('/:id', authMiddleware.authenticateToken, async (req, res) => {
  try {
    const { id } = req.params;
    const { name, color } = req.body;
    const userId = req.user.id;

    // Check if user has access
    const hasAccess = await canUserModifyList(userId, id);
    if (!hasAccess) {
      return res.status(403).json({ error: 'Access denied' });
    }

    const updateData = {};
    if (name !== undefined) updateData.name = name;
    if (color !== undefined) updateData.color = color;
    updateData.updated_at = new Date().toISOString();

    const { data: list, error } = await supabase
      .from('shopping_lists')
      .update(updateData)
      .eq('id', id)
      .select()
      .single();

    if (error) throw error;

    res.json({ success: true, list });
  } catch (error) {
    console.error('Error updating list:', error);
    res.status(500).json({ error: 'Failed to update shopping list' });
  }
});

// DELETE /api/shopping-lists/:id - Delete list (owner only)
router.delete('/:id', authMiddleware.authenticateToken, async (req, res) => {
  try {
    const { id } = req.params;
    const userId = req.user.id;

    // Check if user is owner
    const { data: list } = await supabase
      .from('shopping_lists')
      .select('owner_id')
      .eq('id', id)
      .single();

    if (!list || list.owner_id !== userId) {
      return res.status(403).json({ error: 'Only the owner can delete this list' });
    }

    // Delete list (cascades to items, members, activities)
    const { error } = await supabase
      .from('shopping_lists')
      .delete()
      .eq('id', id);

    if (error) throw error;

    // Decrement usage counter for owned lists
    await decrementUsageCounter(userId, 'owned_shopping_lists');
    console.log('[ShoppingLists] Usage counter decremented for deleted owned list');

    res.json({ success: true });
  } catch (error) {
    console.error('Error deleting list:', error);
    res.status(500).json({ error: 'Failed to delete shopping list' });
  }
});

// POST /api/shopping-lists/:id/items - Add item
router.post('/:id/items', authMiddleware.authenticateToken, async (req, res) => {
  try {
    const { id } = req.params;
    const { name, quantity, unit, category, notes } = req.body;
    const userId = req.user.id;
    const userName = `${req.user.firstName || ''}`.trim() || req.user.email;

    // Check if user has access
    const hasAccess = await canUserModifyList(userId, id);
    if (!hasAccess) {
      return res.status(403).json({ error: 'Access denied' });
    }

    // Shift all existing items down by 1 to make room at the top
    const { data: rpcData, error: rpcError } = await supabase.rpc('increment_order_indices', {
      list_id_param: id
    });

    if (rpcError) {
      // If RPC doesn't exist, do it manually
      if (rpcError.message?.includes('function') || rpcError.message?.includes('exist')) {
        const { data: existingItems } = await supabase
          .from('shopping_list_items')
          .select('id, order_index')
          .eq('list_id', id);

        if (existingItems && existingItems.length > 0) {
          const updates = existingItems.map(item =>
            supabase
              .from('shopping_list_items')
              .update({ order_index: item.order_index + 1 })
              .eq('id', item.id)
          );
          await Promise.all(updates);
        }
      } else {
        throw rpcError;
      }
    }

    // Add new item at the top (order_index = 0)
    const orderIndex = 0;

    // Auto-categorize if no category provided or if 'Other'
    let finalCategory = category;
    if (!category || category === 'Other') {
      const autoCategory = categoryService.categorizeItem(name);
      if (autoCategory) {
        finalCategory = autoCategory;
        console.log(`[ShoppingLists] Auto-categorized "${name}" as "${autoCategory}"`);
      } else {
        finalCategory = 'Other';
      }
    }

    // Add item
    const { data: item, error } = await supabase
      .from('shopping_list_items')
      .insert({
        list_id: id,
        name,
        quantity,
        unit,
        category: finalCategory,
        notes,
        added_by: userId,
        added_by_name: userName,
        order_index: orderIndex
      })
      .select()
      .single();

    if (error) throw error;

    // Log activity
    await supabase
      .from('shopping_list_activities')
      .insert({
        list_id: id,
        user_id: userId,
        user_name: userName,
        action: 'added_item',
        item_name: name
      });

    res.json({ success: true, item });
  } catch (error) {
    console.error('Error adding item:', error);
    res.status(500).json({ error: 'Failed to add item' });
  }
});

// PUT /api/shopping-lists/:id/items/:itemId - Update item
router.put('/:id/items/:itemId', authMiddleware.authenticateToken, async (req, res) => {
  try {
    const { id, itemId } = req.params;
    const { name, quantity, unit, category, notes } = req.body;
    const userId = req.user.id;

    // Check if user has access
    const hasAccess = await canUserModifyList(userId, id);
    if (!hasAccess) {
      return res.status(403).json({ error: 'Access denied' });
    }

    const updateData = {};
    if (name !== undefined) updateData.name = name;
    if (quantity !== undefined) updateData.quantity = quantity;
    if (unit !== undefined) updateData.unit = unit;
    if (category !== undefined) updateData.category = category;
    if (notes !== undefined) updateData.notes = notes;

    const { data: item, error } = await supabase
      .from('shopping_list_items')
      .update(updateData)
      .eq('id', itemId)
      .eq('list_id', id)
      .select()
      .single();

    if (error) throw error;

    res.json({ success: true, item });
  } catch (error) {
    console.error('Error updating item:', error);
    res.status(500).json({ error: 'Failed to update item' });
  }
});

// POST /api/shopping-lists/:id/items/:itemId/toggle - Toggle item checked
router.post('/:id/items/:itemId/toggle', authMiddleware.authenticateToken, async (req, res) => {
  try {
    const { id, itemId } = req.params;
    const userId = req.user.id;
    const userName = `${req.user.firstName || ''}`.trim() || req.user.email;

    // Check if user has access
    const hasAccess = await canUserModifyList(userId, id);
    if (!hasAccess) {
      return res.status(403).json({ error: 'Access denied' });
    }

    // Get current item state
    const { data: currentItem } = await supabase
      .from('shopping_list_items')
      .select('is_checked, name')
      .eq('id', itemId)
      .single();

    if (!currentItem) {
      return res.status(404).json({ error: 'Item not found' });
    }

    const newCheckedState = !currentItem.is_checked;

    // Update item
    const { data: item, error } = await supabase
      .from('shopping_list_items')
      .update({
        is_checked: newCheckedState,
        checked_by: newCheckedState ? userId : null,
        checked_by_name: newCheckedState ? userName : null,
        checked_at: newCheckedState ? new Date().toISOString() : null
      })
      .eq('id', itemId)
      .select()
      .single();

    if (error) throw error;

    // Log activity
    await supabase
      .from('shopping_list_activities')
      .insert({
        list_id: id,
        user_id: userId,
        user_name: userName,
        action: newCheckedState ? 'checked' : 'unchecked',
        item_name: currentItem.name
      });

    res.json({ success: true, item });
  } catch (error) {
    console.error('Error toggling item:', error);
    res.status(500).json({ error: 'Failed to toggle item' });
  }
});

// DELETE /api/shopping-lists/:id/items/:itemId - Delete item
router.delete('/:id/items/:itemId', authMiddleware.authenticateToken, async (req, res) => {
  try {
    const { id, itemId } = req.params;
    const userId = req.user.id;
    const userName = `${req.user.firstName || ''}`.trim() || req.user.email;

    // Check if user has access
    const hasAccess = await canUserModifyList(userId, id);
    if (!hasAccess) {
      return res.status(403).json({ error: 'Access denied' });
    }

    // Get item name for activity log
    const { data: item } = await supabase
      .from('shopping_list_items')
      .select('name')
      .eq('id', itemId)
      .single();

    // Delete item
    const { error } = await supabase
      .from('shopping_list_items')
      .delete()
      .eq('id', itemId);

    if (error) throw error;

    // Log activity
    await supabase
      .from('shopping_list_activities')
      .insert({
        list_id: id,
        user_id: userId,
        user_name: userName,
        action: 'deleted_item',
        item_name: item?.name || 'Unknown item'
      });

    res.json({ success: true });
  } catch (error) {
    console.error('Error deleting item:', error);
    res.status(500).json({ error: 'Failed to delete item' });
  }
});

// POST /api/shopping-lists/:id/clear-completed - Clear completed items
router.post('/:id/clear-completed', authMiddleware.authenticateToken, async (req, res) => {
  try {
    const { id } = req.params;
    const userId = req.user.id;
    const userName = `${req.user.firstName || ''}`.trim() || req.user.email;

    // Check if user has access
    const hasAccess = await canUserModifyList(userId, id);
    if (!hasAccess) {
      return res.status(403).json({ error: 'Access denied' });
    }

    // Get checked items count for activity log
    const { data: checkedItems } = await supabase
      .from('shopping_list_items')
      .select('id')
      .eq('list_id', id)
      .eq('is_checked', true);

    const count = checkedItems?.length || 0;

    // Delete checked items
    const { error } = await supabase
      .from('shopping_list_items')
      .delete()
      .eq('list_id', id)
      .eq('is_checked', true);

    if (error) throw error;

    // Log activity
    await supabase
      .from('shopping_list_activities')
      .insert({
        list_id: id,
        user_id: userId,
        user_name: userName,
        action: 'cleared_completed',
        metadata: { count }
      });

    res.json({ success: true, cleared: count });
  } catch (error) {
    console.error('Error clearing completed:', error);
    res.status(500).json({ error: 'Failed to clear completed items' });
  }
});

// POST /api/shopping-lists/:id/share - Share list with users
router.post('/:id/share', authMiddleware.authenticateToken, async (req, res) => {
  try {
    const { id } = req.params;
    const { emails } = req.body; // Array of emails
    const inviterId = req.user.id;
    const inviterName = `${req.user.firstName || ''}`.trim() || req.user.email;

    // Check if user is owner or member
    const { data: member } = await supabase
      .from('shopping_list_members')
      .select('role')
      .eq('list_id', id)
      .eq('user_id', inviterId)
      .single();

    if (!member) {
      return res.status(403).json({ error: 'You cannot share this list' });
    }

    // Look up users by email
    const { data: users, error: userError } = await supabase
      .from('users')
      .select('id, email, first_name, last_name')
      .in('email', emails);

    if (userError) throw userError;

    if (!users || users.length === 0) {
      return res.status(404).json({ error: 'No users found with those emails' });
    }

    // Add as members (skip if already member)
    const members = users.map(user => ({
      list_id: id,
      user_id: user.id,
      role: 'member',
      invited_by: inviterId,
      invited_by_name: inviterName
    }));

    // Insert members, ignoring conflicts
    for (const memberData of members) {
      const { data: existing } = await supabase
        .from('shopping_list_members')
        .select('id')
        .eq('list_id', memberData.list_id)
        .eq('user_id', memberData.user_id)
        .single();

      if (!existing) {
        await supabase
          .from('shopping_list_members')
          .insert(memberData);
      }
    }

    res.json({
      success: true,
      shared_with: users.length,
      users: users.map(u => ({
        id: u.id,
        email: u.email,
        name: `${u.first_name || ''} ${u.last_name || ''}`.trim()
      }))
    });
  } catch (error) {
    console.error('Error sharing list:', error);
    res.status(500).json({ error: 'Failed to share list' });
  }
});

// GET /api/shopping-lists/join/:shareCode - Join list via share code
router.get('/join/:shareCode', authMiddleware.authenticateToken, checkJoinedListLimit, async (req, res) => {
  try {
    const { shareCode } = req.params;
    const userId = req.user.id;
    const userName = `${req.user.firstName || ''}`.trim() || req.user.email;

    // Find list by share code
    const { data: list, error: listError } = await supabase
      .from('shopping_lists')
      .select('*')
      .eq('share_code', shareCode.toUpperCase())
      .single();

    if (listError || !list) {
      return res.status(404).json({ error: 'Invalid share code' });
    }

    // Check if already a member
    const { data: existingMember } = await supabase
      .from('shopping_list_members')
      .select('id')
      .eq('list_id', list.id)
      .eq('user_id', userId)
      .single();

    if (existingMember) {
      return res.json({
        success: true,
        list,
        message: 'You are already a member of this list'
      });
    }

    // Add user as member
    const { error: memberError } = await supabase
      .from('shopping_list_members')
      .insert({
        list_id: list.id,
        user_id: userId,
        role: 'member',
        invited_by_name: 'Share Link'
      });

    if (memberError) throw memberError;

    // Log activity
    await supabase
      .from('shopping_list_activities')
      .insert({
        list_id: list.id,
        user_id: userId,
        user_name: userName,
        action: 'joined_list'
      });

    // Increment usage counter for joined lists (only if not owner)
    if (list.owner_id !== userId) {
      await incrementUsageCounter(userId, 'joined_shopping_lists');
      console.log('[ShoppingLists] Usage counter incremented for joined list');
    }

    res.json({
      success: true,
      list,
      message: 'Successfully joined the list!'
    });
  } catch (error) {
    console.error('Error joining list:', error);
    res.status(500).json({ error: 'Failed to join list' });
  }
});

// POST /api/shopping-lists/migrate - Migrate from localStorage
router.post('/migrate', authMiddleware.authenticateToken, async (req, res) => {
  try {
    const { lists } = req.body;
    const userId = req.user.id;
    const userName = `${req.user.firstName || ''}`.trim() || req.user.email;

    const migratedLists = [];

    for (const oldList of lists) {
      // Generate share code
      let shareCode = generateShareCode();

      // Ensure unique share code
      let attempts = 0;
      while (attempts < 10) {
        const { data: existing } = await supabase
          .from('shopping_lists')
          .select('id')
          .eq('share_code', shareCode)
          .single();

        if (!existing) break;
        shareCode = generateShareCode();
        attempts++;
      }

      // Create new list
      const { data: newList, error: listError } = await supabase
        .from('shopping_lists')
        .insert({
          name: oldList.name,
          color: oldList.color || '#c3f0ca',
          owner_id: userId,
          share_code: shareCode,
          created_at: oldList.createdAt || new Date().toISOString()
        })
        .select()
        .single();

      if (listError) {
        console.error('Error migrating list:', listError);
        continue;
      }

      // Add owner as member
      await supabase
        .from('shopping_list_members')
        .insert({
          list_id: newList.id,
          user_id: userId,
          role: 'owner',
          invited_by_name: userName
        });

      // Migrate items
      if (oldList.items && oldList.items.length > 0) {
        const itemsToInsert = oldList.items.map((item, index) => ({
          list_id: newList.id,
          name: item.name,
          quantity: item.quantity || '1',
          unit: item.unit,
          category: item.category || 'Other',
          is_checked: item.checked || false,
          added_by: userId,
          added_by_name: userName,
          order_index: index,
          checked_by: item.checked ? userId : null,
          checked_by_name: item.checked ? userName : null,
          checked_at: item.checked ? new Date().toISOString() : null
        }));

        await supabase
          .from('shopping_list_items')
          .insert(itemsToInsert);
      }

      migratedLists.push(newList);
    }

    res.json({
      success: true,
      migrated: migratedLists.length,
      lists: migratedLists
    });
  } catch (error) {
    console.error('Error migrating lists:', error);
    res.status(500).json({ error: 'Failed to migrate shopping lists' });
  }
});

// POST /api/shopping-lists/:id/purchase-to-inventory - Move checked items to inventory
router.post('/:id/purchase-to-inventory', authMiddleware.authenticateToken, async (req, res) => {
  try {
    const { id } = req.params;
    const userId = req.user.id;

    // Check if user has access
    const hasAccess = await canUserModifyList(userId, id);
    if (!hasAccess) {
      return res.status(403).json({ error: 'Access denied' });
    }

    // Get checked items
    const { data: checkedItems } = await supabase
      .from('shopping_list_items')
      .select('*')
      .eq('list_id', id)
      .eq('is_checked', true);

    if (!checkedItems || checkedItems.length === 0) {
      return res.json({ success: true, added: 0 });
    }

    // Add to fridge_items
    const fridgeItems = checkedItems.map(item => ({
      user_id: userId,
      item_name: item.name,
      quantity: parseFloat(item.quantity) || 1,
      unit: item.unit,
      category: item.category || 'Other',
      uploaded_at: new Date().toISOString()
    }));

    const { error: fridgeError } = await supabase
      .from('fridge_items')
      .insert(fridgeItems);

    if (fridgeError) throw fridgeError;

    // Clear from shopping list
    const { error: deleteError } = await supabase
      .from('shopping_list_items')
      .delete()
      .eq('list_id', id)
      .eq('is_checked', true);

    if (deleteError) throw deleteError;

    res.json({
      success: true,
      added: fridgeItems.length,
      message: `Added ${fridgeItems.length} items to your inventory`
    });
  } catch (error) {
    console.error('Error adding to inventory:', error);
    res.status(500).json({ error: 'Failed to add items to inventory' });
  }
});

// POST /api/shopping-lists/:id/items/reorder - Reorder items
router.post('/:id/items/reorder', authMiddleware.authenticateToken, async (req, res) => {
  try {
    const { id } = req.params;
    const { itemIds } = req.body; // Array of item IDs in new order
    const userId = req.user.id;

    // Check if user has access
    const hasAccess = await canUserModifyList(userId, id);
    if (!hasAccess) {
      return res.status(403).json({ error: 'Access denied' });
    }

    // Update order_index for each item
    const updates = itemIds.map((itemId, index) =>
      supabase
        .from('shopping_list_items')
        .update({ order_index: index })
        .eq('id', itemId)
        .eq('list_id', id)
    );

    await Promise.all(updates);

    res.json({ success: true });
  } catch (error) {
    console.error('Error reordering items:', error);
    res.status(500).json({ error: 'Failed to reorder items' });
  }
});

// GET /api/shopping-lists/:id/activities - Get recent activities
router.get('/:id/activities', authMiddleware.authenticateToken, async (req, res) => {
  try {
    const { id } = req.params;
    const userId = req.user.id;
    const { limit = 20 } = req.query;

    // Check if user has access
    const hasAccess = await canUserModifyList(userId, id);
    if (!hasAccess) {
      return res.status(403).json({ error: 'Access denied' });
    }

    const { data: activities, error } = await supabase
      .from('shopping_list_activities')
      .select('*')
      .eq('list_id', id)
      .order('timestamp', { ascending: false })
      .limit(parseInt(limit));

    if (error) throw error;

    res.json({ activities });
  } catch (error) {
    console.error('Error fetching activities:', error);
    res.status(500).json({ error: 'Failed to fetch activities' });
  }
});

// POST /api/shopping-lists/categorize - Batch categorize items
router.post('/categorize', authMiddleware.authenticateToken, async (req, res) => {
  try {
    const { items } = req.body; // Array of item names

    if (!items || !Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ error: 'Items array required' });
    }

    // Limit batch size
    if (items.length > 50) {
      return res.status(400).json({ error: 'Maximum 50 items per request' });
    }

    const categories = await categoryService.categorizeItems(items);
    res.json({ categories });
  } catch (error) {
    console.error('Error categorizing items:', error);
    res.status(500).json({ error: 'Failed to categorize items' });
  }
});

module.exports = router;