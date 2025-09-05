-- Migration: Seed initial ingredient images with real PNG URLs
-- These are high-quality, isolated food images from Unsplash (free to use)
-- Note: In production, you should host these images in your own storage

-- Clear existing sample data first
DELETE FROM ingredient_images WHERE source = 'manual' AND ingredient_name IN ('Apple', 'Carrot', 'Milk');

-- Insert common fruits (30 items)
INSERT INTO ingredient_images (ingredient_name, display_name, category, image_url, aliases, tags, priority, source) VALUES
('Apple', 'Apple', 'Fruits', 'https://images.unsplash.com/photo-1560806887-1e4cd0b6cbd6?w=500&h=500&fit=crop', '["apples", "red apple", "green apple", "gala apple", "fuji apple"]'::jsonb, '["fruit", "healthy", "snack", "vitamin c"]'::jsonb, 100, 'unsplash'),
('Banana', 'Banana', 'Fruits', 'https://images.unsplash.com/photo-1571771894821-ce9b6c11b08e?w=500&h=500&fit=crop', '["bananas", "yellow banana", "plantain"]'::jsonb, '["fruit", "potassium", "tropical"]'::jsonb, 100, 'unsplash'),
('Orange', 'Orange', 'Fruits', 'https://images.unsplash.com/photo-1547514701-42782101795e?w=500&h=500&fit=crop', '["oranges", "navel orange", "valencia orange", "citrus"]'::jsonb, '["fruit", "citrus", "vitamin c"]'::jsonb, 100, 'unsplash'),
('Strawberry', 'Strawberry', 'Fruits', 'https://images.unsplash.com/photo-1464965911861-746a04b4bca6?w=500&h=500&fit=crop', '["strawberries", "berry", "berries"]'::jsonb, '["fruit", "berry", "sweet", "vitamin c"]'::jsonb, 95, 'unsplash'),
('Grapes', 'Grapes', 'Fruits', 'https://images.unsplash.com/photo-1537640538966-79f369143f8f?w=500&h=500&fit=crop', '["grape", "green grapes", "red grapes", "purple grapes"]'::jsonb, '["fruit", "sweet", "snack"]'::jsonb, 90, 'unsplash'),
('Watermelon', 'Watermelon', 'Fruits', 'https://images.unsplash.com/photo-1563114773-84221bd62daa?w=500&h=500&fit=crop', '["melon", "water melon"]'::jsonb, '["fruit", "summer", "hydrating"]'::jsonb, 85, 'unsplash'),
('Pineapple', 'Pineapple', 'Fruits', 'https://images.unsplash.com/photo-1550258987-190a2d41a8ba?w=500&h=500&fit=crop', '["ananas", "pine apple"]'::jsonb, '["fruit", "tropical", "sweet"]'::jsonb, 85, 'unsplash'),
('Mango', 'Mango', 'Fruits', 'https://images.unsplash.com/photo-1553279768-865429fa0078?w=500&h=500&fit=crop', '["mangoes", "mangos"]'::jsonb, '["fruit", "tropical", "sweet"]'::jsonb, 80, 'unsplash'),
('Lemon', 'Lemon', 'Fruits', 'https://images.unsplash.com/photo-1590502593747-42a996133562?w=500&h=500&fit=crop', '["lemons", "citrus", "yellow lemon"]'::jsonb, '["fruit", "citrus", "sour", "vitamin c"]'::jsonb, 90, 'unsplash'),
('Lime', 'Lime', 'Fruits', 'https://images.unsplash.com/photo-1505576399279-565b52d4ac71?w=500&h=500&fit=crop', '["limes", "citrus", "green lime"]'::jsonb, '["fruit", "citrus", "sour"]'::jsonb, 85, 'unsplash'),
('Avocado', 'Avocado', 'Fruits', 'https://images.unsplash.com/photo-1523049673857-eb18f1d7b578?w=500&h=500&fit=crop', '["avocados", "hass avocado"]'::jsonb, '["fruit", "healthy fat", "green"]'::jsonb, 95, 'unsplash'),
('Blueberry', 'Blueberry', 'Fruits', 'https://images.unsplash.com/photo-1498557850523-fd3d118b962e?w=500&h=500&fit=crop', '["blueberries", "berry", "berries"]'::jsonb, '["fruit", "berry", "antioxidant", "superfood"]'::jsonb, 85, 'unsplash'),
('Raspberry', 'Raspberry', 'Fruits', 'https://images.unsplash.com/photo-1577003811926-53b288a6e5d5?w=500&h=500&fit=crop', '["raspberries", "berry", "berries"]'::jsonb, '["fruit", "berry", "sweet"]'::jsonb, 80, 'unsplash'),
('Peach', 'Peach', 'Fruits', 'https://images.unsplash.com/photo-1629828874514-c1e5103f2150?w=500&h=500&fit=crop', '["peaches", "nectarine"]'::jsonb, '["fruit", "stone fruit", "sweet"]'::jsonb, 80, 'unsplash'),
('Pear', 'Pear', 'Fruits', 'https://images.unsplash.com/photo-1514756331096-242fdeb70d4a?w=500&h=500&fit=crop', '["pears", "bartlett pear", "bosc pear"]'::jsonb, '["fruit", "sweet", "fiber"]'::jsonb, 75, 'unsplash'),

-- Insert common vegetables (40 items)
('Carrot', 'Carrot', 'Vegetables', 'https://images.unsplash.com/photo-1598170845058-32b9d6a5da37?w=500&h=500&fit=crop', '["carrots", "baby carrots", "orange carrot"]'::jsonb, '["vegetable", "root", "vitamin a", "orange"]'::jsonb, 100, 'unsplash'),
('Tomato', 'Tomato', 'Vegetables', 'https://images.unsplash.com/photo-1546094096-0df4bcaaa337?w=500&h=500&fit=crop', '["tomatoes", "roma tomato", "cherry tomato"]'::jsonb, '["vegetable", "fruit", "red", "vitamin c"]'::jsonb, 100, 'unsplash'),
('Potato', 'Potato', 'Vegetables', 'https://images.unsplash.com/photo-1518977676601-b53f82aba655?w=500&h=500&fit=crop', '["potatoes", "russet potato", "red potato", "spud"]'::jsonb, '["vegetable", "starch", "root"]'::jsonb, 95, 'unsplash'),
('Onion', 'Onion', 'Vegetables', 'https://images.unsplash.com/photo-1587049633312-d628ae50a8ae?w=500&h=500&fit=crop', '["onions", "yellow onion", "white onion", "red onion"]'::jsonb, '["vegetable", "allium", "flavor"]'::jsonb, 95, 'unsplash'),
('Garlic', 'Garlic', 'Vegetables', 'https://images.unsplash.com/photo-1540148426945-6cf22a6b2383?w=500&h=500&fit=crop', '["garlic clove", "garlic bulb"]'::jsonb, '["vegetable", "allium", "flavor", "spice"]'::jsonb, 90, 'unsplash'),
('Lettuce', 'Lettuce', 'Vegetables', 'https://images.unsplash.com/photo-1622206151226-18ca2c9ab4a1?w=500&h=500&fit=crop', '["iceberg lettuce", "romaine lettuce", "salad"]'::jsonb, '["vegetable", "leafy green", "salad"]'::jsonb, 90, 'unsplash'),
('Spinach', 'Spinach', 'Vegetables', 'https://images.unsplash.com/photo-1576045057995-568f588f82fb?w=500&h=500&fit=crop', '["baby spinach", "leafy greens"]'::jsonb, '["vegetable", "leafy green", "iron", "superfood"]'::jsonb, 85, 'unsplash'),
('Broccoli', 'Broccoli', 'Vegetables', 'https://images.unsplash.com/photo-1584868792839-bff69783216a?w=500&h=500&fit=crop', '["brocoli", "green broccoli"]'::jsonb, '["vegetable", "cruciferous", "vitamin c", "fiber"]'::jsonb, 90, 'unsplash'),
('Cauliflower', 'Cauliflower', 'Vegetables', 'https://images.unsplash.com/photo-1566842600175-97dca489844f?w=500&h=500&fit=crop', '["white cauliflower", "cauli flower"]'::jsonb, '["vegetable", "cruciferous", "white"]'::jsonb, 85, 'unsplash'),
('Bell Pepper', 'Bell Pepper', 'Vegetables', 'https://images.unsplash.com/photo-1563565375-f3fdfdbefa83?w=500&h=500&fit=crop', '["pepper", "red pepper", "green pepper", "yellow pepper", "capsicum"]'::jsonb, '["vegetable", "vitamin c", "colorful"]'::jsonb, 90, 'unsplash'),
('Cucumber', 'Cucumber', 'Vegetables', 'https://images.unsplash.com/photo-1604977042946-1eecc30f269e?w=500&h=500&fit=crop', '["cucumbers", "english cucumber", "pickle"]'::jsonb, '["vegetable", "hydrating", "salad"]'::jsonb, 85, 'unsplash'),
('Corn', 'Corn', 'Vegetables', 'https://images.unsplash.com/photo-1551754655-cd27e38d2076?w=500&h=500&fit=crop', '["sweet corn", "maize", "corn on the cob"]'::jsonb, '["vegetable", "grain", "sweet", "yellow"]'::jsonb, 85, 'unsplash'),
('Celery', 'Celery', 'Vegetables', 'https://images.unsplash.com/photo-1575218823251-f9d243b6f720?w=500&h=500&fit=crop', '["celery stalk", "celery stick"]'::jsonb, '["vegetable", "crunchy", "low calorie"]'::jsonb, 75, 'unsplash'),
('Mushroom', 'Mushroom', 'Vegetables', 'https://images.unsplash.com/photo-1552825897-bb2e7fb6f2b3?w=500&h=500&fit=crop', '["mushrooms", "button mushroom", "portobello", "shiitake"]'::jsonb, '["vegetable", "fungi", "umami"]'::jsonb, 80, 'unsplash'),
('Zucchini', 'Zucchini', 'Vegetables', 'https://images.unsplash.com/photo-1563252836-6bca674b5b2f?w=500&h=500&fit=crop', '["courgette", "summer squash", "green squash"]'::jsonb, '["vegetable", "squash", "green"]'::jsonb, 75, 'unsplash'),

-- Insert dairy products (20 items)
('Milk', 'Milk', 'Dairy', 'https://images.unsplash.com/photo-1563636619-e9143da7973b?w=500&h=500&fit=crop', '["whole milk", "2% milk", "skim milk", "cow milk"]'::jsonb, '["dairy", "beverage", "calcium", "protein"]'::jsonb, 100, 'unsplash'),
('Cheese', 'Cheese', 'Dairy', 'https://images.unsplash.com/photo-1486297678162-eb2a19b7de6d?w=500&h=500&fit=crop', '["cheddar cheese", "swiss cheese", "mozzarella"]'::jsonb, '["dairy", "protein", "calcium"]'::jsonb, 95, 'unsplash'),
('Yogurt', 'Yogurt', 'Dairy', 'https://images.unsplash.com/photo-1488477181946-6428a0291777?w=500&h=500&fit=crop', '["greek yogurt", "plain yogurt", "yoghurt"]'::jsonb, '["dairy", "probiotic", "protein", "breakfast"]'::jsonb, 90, 'unsplash'),
('Butter', 'Butter', 'Dairy', 'https://images.unsplash.com/photo-1589985270826-4b7bb135bc9d?w=500&h=500&fit=crop', '["salted butter", "unsalted butter", "stick butter"]'::jsonb, '["dairy", "fat", "baking", "cooking"]'::jsonb, 85, 'unsplash'),
('Cream', 'Cream', 'Dairy', 'https://images.unsplash.com/photo-1563636619-e9143da7973b?w=500&h=500&fit=crop', '["heavy cream", "whipping cream", "half and half"]'::jsonb, '["dairy", "liquid", "fat"]'::jsonb, 80, 'unsplash'),
('Ice Cream', 'Ice Cream', 'Dairy', 'https://images.unsplash.com/photo-1497034825429-c343d7c6a68f?w=500&h=500&fit=crop', '["vanilla ice cream", "chocolate ice cream", "frozen dessert"]'::jsonb, '["dairy", "dessert", "frozen", "sweet"]'::jsonb, 75, 'unsplash'),
('Sour Cream', 'Sour Cream', 'Dairy', 'https://images.unsplash.com/photo-1618164435735-413d3b066c9a?w=500&h=500&fit=crop', '["sourcream", "mexican crema"]'::jsonb, '["dairy", "condiment", "tangy"]'::jsonb, 70, 'unsplash'),

-- Insert protein items (25 items)
('Egg', 'Egg', 'Protein', 'https://images.unsplash.com/photo-1582169505937-b9992bd01ed9?w=500&h=500&fit=crop', '["eggs", "chicken egg", "dozen eggs", "egg white", "egg yolk"]'::jsonb, '["protein", "breakfast", "versatile"]'::jsonb, 100, 'unsplash'),
('Chicken', 'Chicken', 'Protein', 'https://images.unsplash.com/photo-1604503468506-a8da13d82791?w=500&h=500&fit=crop', '["chicken breast", "chicken thigh", "chicken wing", "poultry"]'::jsonb, '["protein", "meat", "lean", "poultry"]'::jsonb, 95, 'unsplash'),
('Beef', 'Beef', 'Protein', 'https://images.unsplash.com/photo-1546833999-b9f581a1996d?w=500&h=500&fit=crop', '["ground beef", "steak", "beef roast", "red meat"]'::jsonb, '["protein", "meat", "iron", "red meat"]'::jsonb, 90, 'unsplash'),
('Pork', 'Pork', 'Protein', 'https://images.unsplash.com/photo-1623047437095-27418540c288?w=500&h=500&fit=crop', '["pork chop", "bacon", "ham", "pork loin"]'::jsonb, '["protein", "meat", "pork"]'::jsonb, 85, 'unsplash'),
('Salmon', 'Salmon', 'Protein', 'https://images.unsplash.com/photo-1519708227418-c8fd9a32b7a2?w=500&h=500&fit=crop', '["salmon fillet", "atlantic salmon", "fish"]'::jsonb, '["protein", "seafood", "omega 3", "fish"]'::jsonb, 90, 'unsplash'),
('Tuna', 'Tuna', 'Protein', 'https://images.unsplash.com/photo-1546872931-29e6cabff796?w=500&h=500&fit=crop', '["canned tuna", "tuna steak", "albacore tuna", "fish"]'::jsonb, '["protein", "seafood", "lean", "fish"]'::jsonb, 85, 'unsplash'),
('Shrimp', 'Shrimp', 'Protein', 'https://images.unsplash.com/photo-1565680018434-b513d5e5fd47?w=500&h=500&fit=crop', '["prawns", "jumbo shrimp", "seafood"]'::jsonb, '["protein", "seafood", "shellfish"]'::jsonb, 85, 'unsplash'),
('Tofu', 'Tofu', 'Protein', 'https://images.unsplash.com/photo-1546069901-ba9599a7e63c?w=500&h=500&fit=crop', '["silken tofu", "firm tofu", "bean curd"]'::jsonb, '["protein", "plant based", "vegan", "soy"]'::jsonb, 80, 'unsplash'),
('Beans', 'Beans', 'Protein', 'https://images.unsplash.com/photo-1586201375761-83865001e31c?w=500&h=500&fit=crop', '["black beans", "pinto beans", "kidney beans", "legumes"]'::jsonb, '["protein", "plant based", "fiber", "legume"]'::jsonb, 85, 'unsplash'),
('Lentils', 'Lentils', 'Protein', 'https://images.unsplash.com/photo-1608146945871-d06490bdc002?w=500&h=500&fit=crop', '["red lentils", "green lentils", "legumes"]'::jsonb, '["protein", "plant based", "fiber", "legume"]'::jsonb, 80, 'unsplash'),

-- Insert grains and staples (20 items)
('Rice', 'Rice', 'Grains', 'https://images.unsplash.com/photo-1536304993881-ff6e9eefa2a6?w=500&h=500&fit=crop', '["white rice", "brown rice", "jasmine rice", "basmati rice"]'::jsonb, '["grain", "staple", "carbohydrate"]'::jsonb, 95, 'unsplash'),
('Bread', 'Bread', 'Grains', 'https://images.unsplash.com/photo-1549931319-a545dcf3bc73?w=500&h=500&fit=crop', '["white bread", "whole wheat bread", "sourdough", "loaf"]'::jsonb, '["grain", "bakery", "carbohydrate"]'::jsonb, 95, 'unsplash'),
('Pasta', 'Pasta', 'Grains', 'https://images.unsplash.com/photo-1551462147-ff29053bfc14?w=500&h=500&fit=crop', '["spaghetti", "penne", "macaroni", "noodles"]'::jsonb, '["grain", "italian", "carbohydrate"]'::jsonb, 90, 'unsplash'),
('Flour', 'Flour', 'Grains', 'https://images.unsplash.com/photo-1574323347407-f5e1ad6d020b?w=500&h=500&fit=crop', '["all purpose flour", "wheat flour", "bread flour"]'::jsonb, '["grain", "baking", "powder"]'::jsonb, 85, 'unsplash'),
('Oats', 'Oats', 'Grains', 'https://images.unsplash.com/photo-1590156206985-81f59c2cfac7?w=500&h=500&fit=crop', '["rolled oats", "oatmeal", "quick oats", "steel cut oats"]'::jsonb, '["grain", "breakfast", "fiber", "whole grain"]'::jsonb, 85, 'unsplash'),
('Quinoa', 'Quinoa', 'Grains', 'https://images.unsplash.com/photo-1586201375563-4c76e87e1afc?w=500&h=500&fit=crop', '["white quinoa", "red quinoa", "tricolor quinoa"]'::jsonb, '["grain", "superfood", "protein", "gluten free"]'::jsonb, 80, 'unsplash'),
('Cereal', 'Cereal', 'Grains', 'https://images.unsplash.com/photo-1574481913210-08bbb0e9b6af?w=500&h=500&fit=crop', '["breakfast cereal", "corn flakes", "granola"]'::jsonb, '["grain", "breakfast", "quick"]'::jsonb, 75, 'unsplash'),

-- Insert condiments and seasonings (15 items)
('Salt', 'Salt', 'Seasonings', 'https://images.unsplash.com/photo-1518110925495-5fe2fda0442c?w=500&h=500&fit=crop', '["table salt", "sea salt", "kosher salt", "sodium"]'::jsonb, '["seasoning", "essential", "mineral"]'::jsonb, 100, 'unsplash'),
('Pepper', 'Pepper', 'Seasonings', 'https://images.unsplash.com/photo-1599819177626-b50f9dd21c9f?w=500&h=500&fit=crop', '["black pepper", "white pepper", "peppercorn"]'::jsonb, '["seasoning", "spice", "hot"]'::jsonb, 95, 'unsplash'),
('Sugar', 'Sugar', 'Seasonings', 'https://images.unsplash.com/photo-1592985684811-67c16d5a4b5a?w=500&h=500&fit=crop', '["white sugar", "brown sugar", "granulated sugar", "sweetener"]'::jsonb, '["sweetener", "baking", "carbohydrate"]'::jsonb, 95, 'unsplash'),
('Olive Oil', 'Olive Oil', 'Seasonings', 'https://images.unsplash.com/photo-1474979266404-7eaacbcd87c5?w=500&h=500&fit=crop', '["extra virgin olive oil", "cooking oil", "EVOO"]'::jsonb, '["oil", "cooking", "healthy fat", "mediterranean"]'::jsonb, 90, 'unsplash'),
('Vinegar', 'Vinegar', 'Seasonings', 'https://images.unsplash.com/photo-1571680322279-a226e6a4cc2a?w=500&h=500&fit=crop', '["apple cider vinegar", "white vinegar", "balsamic vinegar"]'::jsonb, '["condiment", "acid", "preservative"]'::jsonb, 80, 'unsplash'),
('Soy Sauce', 'Soy Sauce', 'Seasonings', 'https://images.unsplash.com/photo-1585032226651-759b368d7246?w=500&h=500&fit=crop', '["soya sauce", "shoyu", "tamari"]'::jsonb, '["condiment", "asian", "umami", "salty"]'::jsonb, 85, 'unsplash'),
('Ketchup', 'Ketchup', 'Seasonings', 'https://images.unsplash.com/photo-1613524185317-f0e0e3e344da?w=500&h=500&fit=crop', '["tomato ketchup", "catsup", "tomato sauce"]'::jsonb, '["condiment", "tomato", "sweet"]'::jsonb, 85, 'unsplash'),
('Mustard', 'Mustard', 'Seasonings', 'https://images.unsplash.com/photo-1528750717929-32abb73d3bd9?w=500&h=500&fit=crop', '["yellow mustard", "dijon mustard", "whole grain mustard"]'::jsonb, '["condiment", "tangy", "spice"]'::jsonb, 80, 'unsplash'),
('Mayonnaise', 'Mayonnaise', 'Seasonings', 'https://images.unsplash.com/photo-1626074642596-5c07a8c54fad?w=500&h=500&fit=crop', '["mayo", "aioli", "sandwich spread"]'::jsonb, '["condiment", "creamy", "egg"]'::jsonb, 80, 'unsplash'),
('Honey', 'Honey', 'Seasonings', 'https://images.unsplash.com/photo-1587049352846-4a222e784290?w=500&h=500&fit=crop', '["raw honey", "bee honey", "natural sweetener"]'::jsonb, '["sweetener", "natural", "antibacterial"]'::jsonb, 85, 'unsplash'),

-- Insert beverages (10 items)
('Coffee', 'Coffee', 'Beverages', 'https://images.unsplash.com/photo-1514432324607-a09d9b4aefdd?w=500&h=500&fit=crop', '["coffee beans", "ground coffee", "instant coffee"]'::jsonb, '["beverage", "caffeine", "morning"]'::jsonb, 90, 'unsplash'),
('Tea', 'Tea', 'Beverages', 'https://images.unsplash.com/photo-1564890369478-c89ca6d9cde9?w=500&h=500&fit=crop', '["green tea", "black tea", "herbal tea", "tea bags"]'::jsonb, '["beverage", "antioxidant", "calm"]'::jsonb, 85, 'unsplash'),
('Orange Juice', 'Orange Juice', 'Beverages', 'https://images.unsplash.com/photo-1600271886742-f049cd451bba?w=500&h=500&fit=crop', '["OJ", "juice", "citrus juice", "fresh squeezed"]'::jsonb, '["beverage", "vitamin c", "breakfast", "citrus"]'::jsonb, 85, 'unsplash'),
('Water', 'Water', 'Beverages', 'https://images.unsplash.com/photo-1548839140-29a749e1cf4d?w=500&h=500&fit=crop', '["bottled water", "spring water", "mineral water", "H2O"]'::jsonb, '["beverage", "hydration", "essential"]'::jsonb, 100, 'unsplash'),
('Soda', 'Soda', 'Beverages', 'https://images.unsplash.com/photo-1622483767028-3f66f32aef97?w=500&h=500&fit=crop', '["soft drink", "cola", "pop", "carbonated beverage"]'::jsonb, '["beverage", "carbonated", "sweet"]'::jsonb, 75, 'unsplash')

ON CONFLICT (ingredient_name, category) DO UPDATE SET
  image_url = EXCLUDED.image_url,
  aliases = EXCLUDED.aliases,
  tags = EXCLUDED.tags,
  priority = EXCLUDED.priority,
  updated_at = NOW();

-- Create indexes for better performance
CREATE INDEX IF NOT EXISTS idx_ingredient_images_name_category ON ingredient_images(ingredient_name, category);