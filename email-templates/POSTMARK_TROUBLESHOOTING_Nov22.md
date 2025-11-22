# Postmark Email Template Troubleshooting Guide
**Date:** November 22, 2025
**Issue:** Items not appearing in Postmark email templates
**Status:** ✅ SOLVED

---

## 🐛 The Problem

When creating email templates in Postmark for the Trackabite expiry notification system, **items from arrays were not rendering** in the email preview, even though:
- The test data was correctly formatted
- The template syntax looked correct
- The sections (colored boxes) were appearing
- All other template variables (firstName, totalCount, etc.) were working

**What we saw:**
```
✅ Subject: "Alex, you have 5 items expiring soon!"
✅ Greeting: "Hey Alex!"
✅ Section headers: "EXPIRING TODAY", "EXPIRING TOMORROW"
❌ No items showing inside the sections (empty boxes)
```

---

## 🔍 Root Cause Analysis

### Issue #1: Wrong Templating Syntax
**Postmark uses Mustachio**, not standard Mustache templating!

❌ **Standard Mustache (doesn't work in Postmark):**
```html
{{#arrayName}}
  <div>{{name}}</div>
{{/arrayName}}
```

✅ **Mustachio (Postmark's syntax):**
```html
{{#each arrayName}}
  <div>{{name}}</div>
{{/each}}
```

**Key Difference:** Postmark requires the `{{#each}}` keyword to iterate over arrays.

### Issue #2: Scope Access Problem
Even after using `{{#each}}`, items still weren't appearing because of **nested scope issues**.

❌ **Nested without parent scope access (doesn't work):**
```html
{{#hasExpiringToday}}
  {{#each expiringToday}}
    <div>{{name}}</div>
  {{/each}}
{{/hasExpiringToday}}
```

When you nest `{{#each expiringToday}}` inside `{{#hasExpiringToday}}`, you enter the scope of `hasExpiringToday` (which is just `true`). Inside that scope, `expiringToday` is not directly accessible because it's a **sibling property** in the parent scope.

✅ **Correct: Use `../` to access parent scope:**
```html
{{#hasExpiringToday}}
  {{#each ../expiringToday}}
    <div>{{name}}</div>
  {{/each}}
{{/hasExpiringToday}}
```

---

## ✅ The Solution

### Final Working Code Structure:

```html
{{#hasExpiringToday}}
<div class="urgency-section urgent">
  <div class="section-title">⚠️ EXPIRING TODAY</div>
  {{#each ../expiringToday}}
  <div class="item">
    <span><span class="item-emoji">{{emoji}}</span><span class="item-name">{{name}}</span> ({{quantity}})</span>
    <span>{{date}}</span>
  </div>
  {{/each}}
</div>
{{/hasExpiringToday}}
```

**Key Points:**
1. Use `{{#each arrayName}}` for iteration (not `{{#arrayName}}`)
2. Use `../` to access parent scope when nested inside conditionals
3. Close with `{{/each}}` (not `{{/arrayName}}`)

---

## 📚 Postmark Mustachio Syntax Guide

### Basic Variable
```html
{{variableName}}
```

### Conditional (shows if true/exists)
```html
{{#conditionalVariable}}
  <div>This shows if true</div>
{{/conditionalVariable}}
```

### Array Iteration
```html
{{#each arrayName}}
  <div>{{propertyName}}</div>
{{/each}}
```

### Nested Scope - Access Parent
```html
{{#outerProperty}}
  {{#each ../siblingArray}}
    <div>{{name}}</div>
    <div>{{../parentProperty}}</div>
  {{/each}}
{{/outerProperty}}
```

### Check First Item in Loop
```html
{{#each items}}
  {{#@first}}
    <h2>List Header (only shows once)</h2>
  {{/@first}}
  <div>{{name}}</div>
{{/each}}
```

---

## 🎯 Moving Forward: Template Creation Checklist

When creating new Postmark email templates:

### ✅ Before You Start
- [ ] Remember: Postmark uses **Mustachio**, not Mustache
- [ ] Use `{{#each arrayName}}` for ALL arrays
- [ ] Use `../` when accessing sibling properties in nested scopes

### ✅ Template Structure
- [ ] Use `{{#each ../arrayName}}` when nested inside conditionals
- [ ] Close all loops with `{{/each}}` (not `{{/arrayName}}`)
- [ ] Test with real JSON data immediately

### ✅ Testing Process
1. Create template in Postmark
2. Add test data in "Test Data" section (full JSON)
3. Click "Preview" to see rendered email
4. If items don't appear → Check for scope issues
5. Send test email to yourself before going live

---

## 🔧 Common Issues & Quick Fixes

### Issue: "Uh oh! We found some issues with your template"
**Cause:** Variable used in template but not in test data
**Fix:** Add all variables to test data JSON

### Issue: Sections show but items don't
**Cause:** Using `{{#arrayName}}` instead of `{{#each arrayName}}`
**Fix:** Replace all `{{#arrayName}}` with `{{#each arrayName}}`

### Issue: Items still don't show after using {{#each}}
**Cause:** Nested scope problem
**Fix:** Add `../` → `{{#each ../arrayName}}`

### Issue: Variables showing as {{variableName}} in preview
**Cause:** Variable name mismatch or missing from test data
**Fix:** Check spelling, ensure test data has exact variable names

---

## 📖 Official Resources

- **Postmark Template Syntax Guide:** https://postmarkapp.com/support/article/1077-template-syntax
- **Mustachio Documentation:** https://postmarkapp.com/blog/why-were-nuts-about-mustachio
- **Template API Docs:** https://postmarkapp.com/developer/api/templates-api

---

## 🎓 Key Learnings (November 22, 2025)

1. **Postmark ≠ Mustache**: Postmark uses Mustachio, which requires `{{#each}}` for arrays
2. **Scope matters**: Nested properties need `../` to access parent scope
3. **Test immediately**: Don't wait until the end to test with real data
4. **Read the docs**: Email templating engines often have quirks
5. **Document issues**: Save time by documenting solutions (like this file!)

---

## 📝 Example: Complete Working Template

```html
<!DOCTYPE html>
<html>
<body>
  <h1>Hey {{firstName}}!</h1>

  <p>You have {{totalCount}} items expiring soon:</p>

  {{#hasExpiringToday}}
  <div style="background: #ffebee; padding: 15px;">
    <strong>⚠️ EXPIRING TODAY</strong>
    {{#each ../expiringToday}}
      <div>{{emoji}} {{name}} ({{quantity}}) - {{date}}</div>
    {{/each}}
  </div>
  {{/hasExpiringToday}}

  <a href="{{recipesUrl}}">Get Recipes</a>
</body>
</html>
```

**Test Data:**
```json
{
  "firstName": "Alex",
  "totalCount": 3,
  "hasExpiringToday": true,
  "expiringToday": [
    {"name": "Spinach", "quantity": 1, "date": "Nov 20", "emoji": "🥬"},
    {"name": "Milk", "quantity": 1, "date": "Nov 20", "emoji": "🥛"}
  ],
  "recipesUrl": "https://trackabite.app/recipes"
}
```

---

## 🚀 Next Steps

1. **Update main template documentation** (`POSTMARK_TEMPLATES.md`) with `../` syntax
2. **Apply fix to all 3 templates** (daily, weekly, tips)
3. **Test all templates** with real data in Postmark
4. **Send test emails** to yourself
5. **Deploy to production** once confirmed working

---

**Last Updated:** November 22, 2025
**Issue Resolution Time:** ~2 hours
**Future Time Saved:** Countless hours! 🎉

---

## 💡 Pro Tip

When in doubt with Postmark templates:
1. Start simple (no nesting)
2. Test with minimal HTML first
3. Add complexity gradually
4. Always use `{{#each}}` for arrays
5. Add `../` when nested inside other blocks

**Remember:** The `../` is your friend when working with nested Mustachio blocks! 🎯
