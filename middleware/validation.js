// Input validation middleware for shortcuts

const validateShortcutImport = (req, res, next) => {
  const { url, token } = req.body;

  // Validate URL exists
  if (!url || typeof url !== 'string') {
    return res.status(400).json({
      success: false,
      error: 'Invalid or missing URL'
    });
  }

  // Validate URL format (any valid HTTP/HTTPS URL)
  try {
    const parsedUrl = new URL(url.trim());
    if (!['http:', 'https:'].includes(parsedUrl.protocol)) {
      return res.status(400).json({
        success: false,
        error: 'Please provide a valid HTTP or HTTPS URL'
      });
    }
  } catch (e) {
    return res.status(400).json({
      success: false,
      error: 'Please provide a valid URL'
    });
  }

  // Validate token format
  if (!token || typeof token !== 'string') {
    return res.status(400).json({
      success: false,
      error: 'Invalid or missing authentication token'
    });
  }
  
  // Token should start with our prefix
  const tokenPrefix = process.env.SHORTCUT_TOKEN_PREFIX || 'scut_';
  if (!token.startsWith(tokenPrefix)) {
    return res.status(400).json({
      success: false,
      error: 'Invalid token format'
    });
  }
  
  // Sanitize inputs
  req.body.url = url.trim();
  req.body.token = token.trim();
  
  next();
};

// Every client renders only analyzedInstructions[0].steps, so a recipe the
// model split into several named sections showed just the first one. When a
// creator writes titled blocks ("Marinade", "Frying", "Toss and serve"), each
// block becomes ONE step led by its title. A long block (the creator numbered
// many steps under one heading) keeps its steps, with the title on the first.
// Untitled sections keep their steps exactly as they are.
// A single untitled group, the normal case, is returned unchanged.
const MERGE_MAX_STEPS = 6;
const MERGE_MAX_CHARS = 600;
const GENERIC_SECTION_TITLE = /^(method|methods|instructions?|directions?|steps?|how to make( it)?)$/i;
const COOKING_TECHNIQUE_END = /(bak(e|ing)|air ?fry(er|ing)?|oven|stove ?top|slow cooker|instant pot|pressure cooker|grill(ing)?|fry(ing)?|microwave|sous vide)$/i;

const cleanSectionTitle = (name) => {
  let title = String(name || '').replace(/\s+/g, ' ').trim().replace(/[:\-–—]+$/, '').trim();
  // "Method (marinade)" → "marinade"
  const wrapped = title.match(/^(method|instructions?|directions?|steps?)\s*\((.+)\)$/i);
  if (wrapped) title = wrapped[2].trim();
  // "Garlic parmesan sauce Method" → "Garlic parmesan sauce", but keep
  // alternatives like "Baking Method" / "Air Fryer Method".
  const trailing = title.match(/^(.+?)\s+(method|instructions?|directions?|steps?)$/i);
  if (trailing && !COOKING_TECHNIQUE_END.test(trailing[1])) title = trailing[1].trim();
  if (!title || GENERIC_SECTION_TITLE.test(title)) return '';
  return title.charAt(0).toUpperCase() + title.slice(1);
};

const joinSentences = (texts) => texts.reduce((acc, text) => {
  if (!acc) return text;
  return /[.!?…)"'”]$/.test(acc) ? `${acc} ${text}` : `${acc}. ${text}`;
}, '');

const mergeInstructionSections = (analyzedInstructions) => {
  if (!Array.isArray(analyzedInstructions) || analyzedInstructions.length <= 1) {
    return analyzedInstructions;
  }

  const sections = analyzedInstructions
    .map((group) => ({
      title: cleanSectionTitle(group?.name),
      steps: (Array.isArray(group?.steps) ? group.steps : [])
        .map((s) => ({ ...s, step: String(s?.step || '').replace(/\s+/g, ' ').trim() }))
        .filter((s) => s.step),
    }))
    .filter((section) => section.steps.length > 0);

  const steps = [];
  for (const { title, steps: sectionSteps } of sections) {
    const prefix = title ? `${title}: ` : '';
    const totalChars = sectionSteps.reduce((sum, s) => sum + s.step.length, 0);
    if (title && sectionSteps.length <= MERGE_MAX_STEPS && totalChars <= MERGE_MAX_CHARS) {
      steps.push({ ...sectionSteps[0], step: prefix + joinSentences(sectionSteps.map((s) => s.step)) });
    } else {
      sectionSteps.forEach((s, i) => steps.push({ ...s, step: i === 0 ? prefix + s.step : s.step }));
    }
  }

  return [{ name: '', steps: steps.map((s, i) => ({ ...s, number: i + 1 })) }];
};

const sanitizeRecipeData = (recipeData) => {
  // Determine source type from URL if not provided
  const sourceUrl = recipeData.source_url || recipeData.sourceUrl || '';
  const sourceType = recipeData.source_type ||
    (sourceUrl.includes('instagram.com') ? 'instagram' :
     sourceUrl.includes('facebook.com') || sourceUrl.includes('fb.watch') ? 'facebook' :
     sourceUrl.includes('tiktok.com') || sourceUrl.includes('vm.tiktok.com') || sourceUrl.includes('vt.tiktok.com') ? 'tiktok' : 'web');

  // Ensure all required fields are present and properly typed
  return {
    title: String(recipeData.title || 'Untitled Recipe').substring(0, 255),
    summary: String(recipeData.summary || '').substring(0, 1000),
    image: String(recipeData.image || ''),
    extendedIngredients: Array.isArray(recipeData.extendedIngredients)
      ? recipeData.extendedIngredients
      : [],
    analyzedInstructions: Array.isArray(recipeData.analyzedInstructions)
      ? mergeInstructionSections(recipeData.analyzedInstructions)
      : [],
    readyInMinutes: parseInt(recipeData.readyInMinutes) || null,
    servings: parseInt(recipeData.servings) || 4,
    vegetarian: Boolean(recipeData.vegetarian),
    vegan: Boolean(recipeData.vegan),
    glutenFree: Boolean(recipeData.glutenFree),
    dairyFree: Boolean(recipeData.dairyFree),
    // Add source metadata - using snake_case to match database columns
    source_type: sourceType,
    source_url: sourceUrl,
    source_author: String(recipeData.source_author || recipeData.sourceAuthor || '').substring(0, 255),
    source_author_image: String(recipeData.source_author_image || recipeData.sourceAuthorImage || ''),
    import_method: recipeData.import_method || 'ios_shortcut'
  };
};

module.exports = {
  validateShortcutImport,
  sanitizeRecipeData,
  mergeInstructionSections
};