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

// GET /api/shopping-lists/public/:shareCode - Public view of a shared list (no auth)
router.get('/public/:shareCode', async (req, res) => {
  try {
    const { shareCode } = req.params;
    const normalized = shareCode.toUpperCase().replace(/[^A-Z0-9]/g, '');
    const formatted = normalized.length === 8
      ? `${normalized.slice(0, 4)}-${normalized.slice(4)}`
      : shareCode.toUpperCase();

    const { data: list, error } = await supabase
      .from('shopping_lists')
      .select('name, color, shopping_list_items(name, quantity, unit, category, is_checked)')
      .eq('share_code', formatted)
      .single();

    if (error || !list) {
      return res.status(404).json({ error: 'List not found' });
    }

    const items = list.shopping_list_items || [];
    const unchecked = items.filter(i => !i.is_checked);
    const checked = items.filter(i => i.is_checked);

    // Return HTML for browsers
    if (req.accepts('html') && !req.accepts('json')) {
      const esc = (s) => String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');

      const renderItem = (item, done) => {
        const qty = [item.quantity, item.unit].filter(Boolean).join(' ');
        const label = esc(qty ? `${item.name} — ${qty}` : item.name);
        return `<li style="padding:12px 0;border-bottom:1px solid #e9e9e1;${done ? 'text-decoration:line-through;color:#9ca3af;' : 'color:#2e2f2b;'}font-size:16px;list-style:none;">${done ? '&#10003; ' : ''}${label}</li>`;
      };

      const checkedSection = checked.length > 0
        ? `<div style="margin-top:24px;"><p style="font-size:13px;font-weight:700;color:#8a8b86;text-transform:uppercase;letter-spacing:1px;margin-bottom:8px;">Done (${checked.length})</p><ul style="margin:0;padding:0;">${checked.map(i => renderItem(i, true)).join('')}</ul></div>`
        : '';

      const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>${esc(list.name)} — Trackabite</title>
  <meta property="og:title" content="${esc(list.name)}">
  <meta property="og:description" content="Shopping list with ${items.length} item${items.length !== 1 ? 's' : ''} — shared from Trackabite">
  <meta property="og:type" content="website">
  <style>*{margin:0;padding:0;box-sizing:border-box;}body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;background:#f8f7f0;min-height:100vh;}</style>
</head>
<body>
  <div style="max-width:480px;margin:0 auto;padding:20px 16px 40px;">
    <div style="text-align:center;margin-bottom:24px;padding-top:20px;">
      <p style="font-size:13px;color:#8a8b86;margin-bottom:4px;">Shared from Trackabite</p>
      <h1 style="font-size:24px;font-weight:800;color:#2e2f2b;letter-spacing:-0.3px;">${esc(list.name)}</h1>
      <p style="font-size:14px;color:#8a8b86;margin-top:4px;">${items.length} item${items.length !== 1 ? 's' : ''}</p>
    </div>
    <div style="background:#fff;border-radius:16px;padding:16px 20px;box-shadow:0 1px 3px rgba(0,0,0,0.06);">
      <ul style="margin:0;padding:0;">${unchecked.map(i => renderItem(i, false)).join('')}</ul>
      ${checkedSection}
    </div>
    <div style="text-align:center;margin-top:32px;">
      <a href="https://apps.apple.com/app/trackabite/id6738028065" style="display:inline-block;background:#c5fe01;color:#2e2f2b;font-weight:700;font-size:15px;padding:14px 32px;border-radius:50px;text-decoration:none;">Get Trackabite</a>
    </div>
  </div>
</body>
</html>`;

      return res.type('html').send(html);
    }

    // JSON response for API consumers
    res.json({
      success: true,
      list: {
        name: list.name,
        color: list.color,
        items: items.map(i => ({
          name: i.name,
          quantity: i.quantity,
          unit: i.unit,
          category: i.category,
          is_checked: i.is_checked,
        })),
      },
    });
  } catch (error) {
    console.error('Error fetching public list:', error);
    res.status(500).json({ error: 'Failed to fetch list' });
  }
});

// POST /api/shopping-lists/public/:shareCode/toggle/:itemId - Toggle item check from web (no auth)
router.post('/public/:shareCode/toggle/:itemId', async (req, res) => {
  try {
    const { shareCode, itemId } = req.params;
    const normalized = shareCode.toUpperCase().replace(/[^A-Z0-9]/g, '');
    const formatted = normalized.length === 8
      ? `${normalized.slice(0, 4)}-${normalized.slice(4)}`
      : shareCode.toUpperCase();

    // Find list by share code
    const { data: list, error: listError } = await supabase
      .from('shopping_lists')
      .select('id')
      .eq('share_code', formatted)
      .single();

    if (listError || !list) {
      return res.status(404).json({ error: 'List not found' });
    }

    // Get current item state and verify it belongs to this list
    const { data: currentItem } = await supabase
      .from('shopping_list_items')
      .select('is_checked, name')
      .eq('id', itemId)
      .eq('list_id', list.id)
      .single();

    if (!currentItem) {
      return res.status(404).json({ error: 'Item not found' });
    }

    const newCheckedState = !currentItem.is_checked;

    const { error: updateError } = await supabase
      .from('shopping_list_items')
      .update({
        is_checked: newCheckedState,
        checked_by_name: newCheckedState ? 'Web' : null,
        checked_at: newCheckedState ? new Date().toISOString() : null,
      })
      .eq('id', itemId);

    if (updateError) throw updateError;

    res.json({ success: true, is_checked: newCheckedState });
  } catch (error) {
    console.error('Error toggling item:', error);
    res.status(500).json({ error: 'Failed to toggle item' });
  }
});

// GET /api/shopping-lists/join-page/:shareCode - Public landing page for collab list join links (no auth)
router.get('/join-page/:shareCode', async (req, res) => {
  try {
    const { shareCode } = req.params;
    const normalized = shareCode.toUpperCase().replace(/[^A-Z0-9]/g, '');
    const formatted = normalized.length === 8
      ? `${normalized.slice(0, 4)}-${normalized.slice(4)}`
      : shareCode.toUpperCase();

    const { data: list, error } = await supabase
      .from('shopping_lists')
      .select('name, color, shopping_list_items(id, name, quantity, unit, is_checked)')
      .eq('share_code', formatted)
      .single();

    if (error || !list) {
      return res.status(404).json({ error: 'List not found' });
    }

    const items = list.shopping_list_items || [];
    const unchecked = items.filter(i => !i.is_checked);
    const checked = items.filter(i => i.is_checked);
    const itemCount = items.length;
    const esc = (s) => String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');

    const renderItem = (item) => {
      const qty = [item.quantity, item.unit].filter(Boolean).join(' ');
      const label = esc(qty ? `${item.name} — ${qty}` : item.name);
      const checkedAttr = item.is_checked ? 'checked' : '';
      const strikeStyle = item.is_checked ? 'text-decoration:line-through;color:#9ca3af;' : '';
      return `<li class="item" id="item-${item.id}">
        <label style="display:flex;align-items:center;gap:12px;padding:14px 0;border-bottom:1px solid #e9e9e1;cursor:pointer;">
          <input type="checkbox" ${checkedAttr} onchange="toggleItem('${item.id}', this)" style="width:22px;height:22px;accent-color:#4c6400;cursor:pointer;flex-shrink:0;">
          <span style="${strikeStyle}font-size:16px;color:${item.is_checked ? '#9ca3af' : '#2e2f2b'};" id="label-${item.id}">${label}</span>
        </label>
      </li>`;
    };

    const checkedSection = checked.length > 0
      ? `<div style="margin-top:24px;" id="done-section">
          <p style="font-size:13px;font-weight:700;color:#8a8b86;text-transform:uppercase;letter-spacing:1px;margin-bottom:8px;">Done (<span id="done-count">${checked.length}</span>)</p>
          <ul style="margin:0;padding:0;list-style:none;" id="done-list">${checked.map(i => renderItem(i)).join('')}</ul>
        </div>`
      : '<div style="display:none;" id="done-section"><p style="font-size:13px;font-weight:700;color:#8a8b86;text-transform:uppercase;letter-spacing:1px;margin-bottom:8px;margin-top:24px;">Done (<span id="done-count">0</span>)</p><ul style="margin:0;padding:0;list-style:none;" id="done-list"></ul></div>';

    const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>${esc(list.name)} — Trackabite</title>
  <meta property="og:title" content="${esc(list.name)}">
  <meta property="og:description" content="Shopping list with ${itemCount} item${itemCount !== 1 ? 's' : ''} — shared from Trackabite">
  <meta property="og:type" content="website">
  <style>
    *{margin:0;padding:0;box-sizing:border-box;}
    body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;background:#f8f7f0;min-height:100vh;}
  </style>
</head>
<body>
  <div style="max-width:480px;margin:0 auto;padding:20px 16px 40px;">
    <div style="text-align:center;margin-bottom:24px;padding-top:20px;">
      <p style="font-size:13px;color:#8a8b86;margin-bottom:4px;">Shared from Trackabite</p>
      <h1 style="font-size:24px;font-weight:800;color:#2e2f2b;letter-spacing:-0.3px;">${esc(list.name)}</h1>
      <p style="font-size:14px;color:#8a8b86;margin-top:4px;">${itemCount} item${itemCount !== 1 ? 's' : ''}</p>
    </div>
    <div style="background:#fff;border-radius:16px;padding:16px 20px;box-shadow:0 1px 3px rgba(0,0,0,0.06);">
      <ul style="margin:0;padding:0;list-style:none;" id="todo-list">${unchecked.map(i => renderItem(i)).join('')}</ul>
      ${checkedSection}
    </div>
    <div style="text-align:center;margin-top:32px;">
      <a href="trackabite://join/list/${formatted}" style="display:inline-block;background:#c5fe01;color:#2e2f2b;font-weight:700;font-size:15px;padding:14px 32px;border-radius:50px;text-decoration:none;">Open in Trackabite</a>
      <br>
      <a href="https://apps.apple.com/app/trackabite/id6738028065" style="display:inline-block;color:#4c6400;font-weight:600;font-size:14px;margin-top:12px;text-decoration:none;">Get the app →</a>
    </div>
  </div>
  <script>
    var apiBase = window.location.origin + '/api/shopping-lists';
    var shareCode = '${formatted}';

    function toggleItem(itemId, checkbox) {
      var label = document.getElementById('label-' + itemId);
      var isNowChecked = checkbox.checked;

      // Optimistic UI update
      if (isNowChecked) {
        label.style.textDecoration = 'line-through';
        label.style.color = '#9ca3af';
      } else {
        label.style.textDecoration = 'none';
        label.style.color = '#2e2f2b';
      }

      fetch(apiBase + '/public/' + shareCode + '/toggle/' + itemId, { method: 'POST' })
        .then(function(r) { return r.json(); })
        .then(function(data) {
          if (!data.success) {
            checkbox.checked = !isNowChecked;
            label.style.textDecoration = isNowChecked ? 'none' : 'line-through';
            label.style.color = isNowChecked ? '#2e2f2b' : '#9ca3af';
          }
        })
        .catch(function() {
          checkbox.checked = !isNowChecked;
          label.style.textDecoration = isNowChecked ? 'none' : 'line-through';
          label.style.color = isNowChecked ? '#2e2f2b' : '#9ca3af';
        });
    }
  </script>
</body>
</html>`;

    res.type('html').send(html);
  } catch (error) {
    console.error('Error fetching join page:', error);
    res.status(500).json({ error: 'Failed to load join page' });
  }
});

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

    // Collect all member user IDs to fetch names
    const allMemberIds = new Set();
    lists.forEach(list => {
      list.shopping_list_members?.forEach(m => allMemberIds.add(m.user_id));
    });

    // Fetch member names
    let usersMap = {};
    if (allMemberIds.size > 0) {
      const { data: users } = await supabase
        .from('users')
        .select('id, first_name')
        .in('id', Array.from(allMemberIds));
      if (users) {
        users.forEach(u => { usersMap[u.id] = u.first_name; });
      }
    }

    // Format response with counts and member names
    const formattedLists = lists.map(list => ({
      ...list,
      total_items: list.shopping_list_items?.length || 0,
      checked_items: list.shopping_list_items?.filter(i => i.is_checked).length || 0,
      member_count: list.shopping_list_members?.length || 0,
      is_owner: list.owner_id === userId,
      members: (list.shopping_list_members || []).map(m => ({
        user_id: m.user_id,
        first_name: usersMap[m.user_id] || null,
      })),
    }));

    res.json({ lists: formattedLists });
  } catch (error) {
    console.error('Error fetching lists:', error);
    res.status(500).json({ error: 'Failed to fetch shopping lists' });
  }
});

// POST /api/shopping-lists - Create new list (unlimited for all tiers)
router.post('/', authMiddleware.authenticateToken, async (req, res) => {
  try {
    const { name, color, items, settings } = req.body;
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
        share_code: shareCode,
        settings: settings || {}
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

    // Check if user has premium access (sharing is premium only)
    const { data: userData } = await supabase
      .from('users')
      .select('tier')
      .eq('id', inviterId)
      .single();

    const userTier = userData?.tier || 'free';
    if (userTier === 'free') {
      return res.status(402).json({
        error: 'SHARING_PREMIUM_ONLY',
        message: 'List sharing is only available with a premium subscription.',
        upgradeRequired: true,
      });
    }

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

// POST /api/shopping-lists/:id/items/batch - Add multiple items with aggregation
router.post('/:id/items/batch', authMiddleware.authenticateToken, async (req, res) => {
  try {
    const { id } = req.params;
    const { items } = req.body; // Array of { name, quantity, unit, category }
    const userId = req.user.id;
    const userName = `${req.user.firstName || ''}`.trim() || req.user.email;

    if (!items || !Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ error: 'Items array is required' });
    }

    // Check if user has access
    const hasAccess = await canUserModifyList(userId, id);
    if (!hasAccess) {
      return res.status(403).json({ error: 'Access denied' });
    }

    console.log(`[ShoppingLists] Adding ${items.length} items to list ${id} with aggregation`);

    // Fetch existing items in the list
    const { data: existingItems, error: fetchError } = await supabase
      .from('shopping_list_items')
      .select('*')
      .eq('list_id', id);

    if (fetchError) throw fetchError;

    // Import aggregation services
    const ingredientAggregationService = require('../services/ingredientAggregationService');
    const unitConversionService = require('../services/unitConversionService');

    // Build a map of normalized existing items for fast lookup
    const existingMap = new Map();
    for (const item of (existingItems || [])) {
      const normalized = ingredientAggregationService.normalizeIngredientName(item.name);
      if (normalized) {
        existingMap.set(normalized, item);
      }
    }

    const itemsToInsert = [];
    const itemsToUpdate = [];

    // Process each new item
    for (const newItem of items) {
      const normalized = ingredientAggregationService.normalizeIngredientName(newItem.name);
      if (!normalized) continue;

      const existingItem = existingMap.get(normalized);

      if (existingItem) {
        // Try to aggregate with existing item
        const newAmount = parseFloat(newItem.quantity) || 0;
        const existingAmount = parseFloat(existingItem.quantity) || 0;
        const newUnit = newItem.unit || '';
        const existingUnit = existingItem.unit || '';

        if (unitConversionService.canCombine(existingUnit, newUnit)) {
          const combined = unitConversionService.combineQuantities(
            existingAmount,
            existingUnit,
            newAmount,
            newUnit
          );

          if (combined) {
            console.log(`[ShoppingLists] Aggregating "${newItem.name}": ${existingAmount} ${existingUnit} + ${newAmount} ${newUnit} = ${combined.amount} ${combined.unit}`);
            itemsToUpdate.push({
              id: existingItem.id,
              quantity: String(combined.amount),
              unit: combined.unit
            });
            // Remove from existingMap so we don't double-aggregate
            existingMap.delete(normalized);
            continue;
          }
        }

        // Units incompatible - add as new item (e.g., "1 head" vs "2 cups")
        console.log(`[ShoppingLists] Units incompatible for "${newItem.name}", adding as new item`);
      }

      // Auto-categorize if needed
      let finalCategory = newItem.category;
      if (!finalCategory || finalCategory === 'Other') {
        const autoCategory = categoryService.categorizeItem(newItem.name);
        if (autoCategory) {
          finalCategory = autoCategory;
        } else {
          finalCategory = 'Other';
        }
      }

      itemsToInsert.push({
        list_id: id,
        name: newItem.name,
        quantity: newItem.quantity || '1',
        unit: newItem.unit || '',
        category: finalCategory,
        added_by: userId,
        added_by_name: userName,
        is_checked: false
      });
    }

    const results = { inserted: [], updated: [] };

    // Update existing items that were aggregated
    if (itemsToUpdate.length > 0) {
      console.log(`[ShoppingLists] Updating ${itemsToUpdate.length} aggregated items`);
      for (const update of itemsToUpdate) {
        const { data, error } = await supabase
          .from('shopping_list_items')
          .update({ quantity: update.quantity, unit: update.unit })
          .eq('id', update.id)
          .select()
          .single();

        if (!error && data) {
          results.updated.push(data);
        }
      }
    }

    // Insert new items
    if (itemsToInsert.length > 0) {
      console.log(`[ShoppingLists] Inserting ${itemsToInsert.length} new items`);

      // Shift existing items' order indices to make room at top
      const shiftCount = itemsToInsert.length;
      const { error: rpcError } = await supabase.rpc('increment_order_indices_by', {
        list_id_param: id,
        increment_by: shiftCount
      });

      if (rpcError) {
        // Fallback: manual shift if RPC doesn't exist
        if (rpcError.message?.includes('function') || rpcError.message?.includes('exist')) {
          const { data: currentItems } = await supabase
            .from('shopping_list_items')
            .select('id, order_index')
            .eq('list_id', id);

          if (currentItems && currentItems.length > 0) {
            const updates = currentItems.map(item =>
              supabase
                .from('shopping_list_items')
                .update({ order_index: (item.order_index || 0) + shiftCount })
                .eq('id', item.id)
            );
            await Promise.all(updates);
          }
        } else {
          throw rpcError;
        }
      }

      // Assign order indices to new items (0, 1, 2, ...)
      const itemsWithOrder = itemsToInsert.map((item, index) => ({
        ...item,
        order_index: index
      }));

      const { data: insertedItems, error: insertError } = await supabase
        .from('shopping_list_items')
        .insert(itemsWithOrder)
        .select();

      if (insertError) throw insertError;
      results.inserted = insertedItems || [];
    }

    // Log activity
    await supabase
      .from('shopping_list_activities')
      .insert({
        list_id: id,
        user_id: userId,
        user_name: userName,
        action: 'batch_added_items',
        metadata: {
          inserted_count: results.inserted.length,
          updated_count: results.updated.length,
          total_items: items.length
        }
      });

    console.log(`[ShoppingLists] Batch complete: ${results.inserted.length} inserted, ${results.updated.length} aggregated`);

    res.json({
      success: true,
      inserted: results.inserted,
      updated: results.updated,
      summary: {
        inserted_count: results.inserted.length,
        updated_count: results.updated.length
      }
    });
  } catch (error) {
    console.error('Error batch adding items:', error);
    res.status(500).json({ error: 'Failed to add items' });
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

// POST /api/shopping-lists/:id/add-recipe - Add recipe metadata to list settings
router.post('/:id/add-recipe', authMiddleware.authenticateToken, async (req, res) => {
  try {
    const { id } = req.params;
    const { recipe } = req.body;
    const userId = req.user.id;

    if (!recipe || !recipe.id) {
      return res.status(400).json({ error: 'Recipe data required' });
    }

    // Check access
    const hasAccess = await canUserModifyList(userId, id);
    if (!hasAccess) {
      return res.status(403).json({ error: 'Access denied' });
    }

    // Get current settings
    const { data: list, error: fetchError } = await supabase
      .from('shopping_lists')
      .select('settings')
      .eq('id', id)
      .single();

    if (fetchError) throw fetchError;

    const currentSettings = list?.settings || {};
    const sourceRecipes = currentSettings.source_recipes || [];

    // Check if recipe already exists
    const existingIndex = sourceRecipes.findIndex(r => r.id === recipe.id);

    if (existingIndex >= 0) {
      // Increment count for existing recipe
      sourceRecipes[existingIndex].count = (sourceRecipes[existingIndex].count || 1) + 1;
    } else {
      // Add new recipe with count: 1
      sourceRecipes.push({
        id: recipe.id,
        title: recipe.title,
        image: recipe.image,
        readyInMinutes: recipe.readyInMinutes,
        servings: recipe.servings || 1,
        count: 1
      });
    }

    // Update settings
    const { error: updateError } = await supabase
      .from('shopping_lists')
      .update({
        settings: { ...currentSettings, source_recipes: sourceRecipes }
      })
      .eq('id', id);

    if (updateError) throw updateError;

    res.json({ success: true, source_recipes: sourceRecipes });
  } catch (error) {
    console.error('Error adding recipe to list:', error);
    res.status(500).json({ error: 'Failed to add recipe to list' });
  }
});

module.exports = router;