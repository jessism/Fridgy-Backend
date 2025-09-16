const axios = require('axios');
const { createClient } = require('@supabase/supabase-js');

class InstagramExtractor {
  constructor() {
    this.supabase = createClient(
      process.env.SUPABASE_URL,
      process.env.SUPABASE_ANON_KEY
    );
    this.rapidApiKey = process.env.RAPIDAPI_KEY;

    // Multiple API hosts for fallback - Updated to more reliable providers
    this.apiHosts = [
      process.env.RAPIDAPI_HOST_1 || 'instagram-scraper2.p.rapidapi.com',
      process.env.RAPIDAPI_HOST_2 || 'instagram-scraper-api2.p.rapidapi.com',
      process.env.RAPIDAPI_HOST_3 || 'instagram47.p.rapidapi.com',
      process.env.RAPIDAPI_HOST || 'instagram-scraper-api2.p.rapidapi.com'
    ];
  }

  async extractFromUrl(instagramUrl) {
    console.log(`[InstagramExtractor] Extracting from: ${instagramUrl}`);

    // Check cache first
    const cached = await this.checkCache(instagramUrl);
    if (cached) {
      console.log('[InstagramExtractor] Found in cache');
      return cached;
    }

    // For testing without API key, return mock data
    if (!this.rapidApiKey || this.rapidApiKey === 'your_key_here') {
      console.log('[InstagramExtractor] No API key configured, returning mock data for testing');
      return this.getMockData(instagramUrl);
    }

    // Try multiple APIs in sequence
    for (let i = 0; i < this.apiHosts.length; i++) {
      const host = this.apiHosts[i];
      console.log(`[InstagramExtractor] Trying API ${i + 1}/${this.apiHosts.length}: ${host}`);

      const result = await this.tryExtractWithAPI(instagramUrl, host, i);
      if (result.success) {
        console.log(`[InstagramExtractor] Success with API ${i + 1}: ${host}`);

        // Cache the result
        await this.cacheResult(instagramUrl, result);
        return result;
      }

      console.log(`[InstagramExtractor] API ${i + 1} failed, trying next...`);
    }

    // All APIs failed - try direct page fetch as last resort
    console.log('[InstagramExtractor] All APIs failed, trying direct page fetch...');
    const directResult = await this.tryDirectPageFetch(instagramUrl);

    if (directResult.success) {
      console.log('[InstagramExtractor] Direct page fetch succeeded');
      await this.cacheResult(instagramUrl, directResult);
      return directResult;
    }

    // Everything failed - return with flag for manual caption
    console.log('[InstagramExtractor] All methods failed, manual caption required');
    return {
      success: false,
      url: instagramUrl,
      error: 'Could not automatically fetch Instagram content',
      requiresManualCaption: true,
      requiresManualInput: true,
      caption: '',
      images: [],
      author: { username: 'unknown' },
      hashtags: []
    };
  }

  async tryExtractWithAPI(instagramUrl, apiHost, apiIndex) {
    try {
      let endpoint, params, method = 'GET';

      // Different endpoints for different APIs
      if (apiHost.includes('instagram-scraper2')) {
        // API 1: instagram-scraper2
        endpoint = `https://${apiHost}/v1/post_info`;
        params = { code_or_id_or_url: instagramUrl };
      } else if (apiHost.includes('instagram-scraper-api2')) {
        // API 2: instagram-scraper-api2
        endpoint = `https://${apiHost}/v1/post_info`;
        params = { code_or_id_or_url: instagramUrl };
      } else if (apiHost.includes('instagram47')) {
        // API 3: instagram47 (legacy)
        endpoint = `https://${apiHost}/v1.2/posts/details`;
        params = { url: instagramUrl };
      } else {
        // Default/Fallback API
        endpoint = `https://${apiHost}/v1/post_info`;
        params = { code_or_id_or_url: instagramUrl };
      }

      console.log(`[InstagramExtractor] Calling: ${endpoint}`);

      const response = await axios({
        method: method,
        url: endpoint,
        params: params,
        headers: {
          'X-RapidAPI-Key': this.rapidApiKey,
          'X-RapidAPI-Host': apiHost,
          'Accept': 'application/json'
        },
        timeout: 15000 // Increased timeout for more reliable APIs
      });

      // Parse response based on API
      const extractedData = this.parseResponseByAPI(response.data, apiIndex);

      // Check if we got actual caption content
      if (extractedData.caption && extractedData.caption.length > 20) {
        extractedData.success = true;
        return extractedData;
      }

      return { success: false };

    } catch (error) {
      console.error(`[InstagramExtractor] API ${apiIndex + 1} error:`, error.message);
      return { success: false, error: error.message };
    }
  }

  parseResponseByAPI(data, apiIndex) {
    const apiHost = this.apiHosts[apiIndex];

    // Different APIs have different response structures
    if (apiHost.includes('instagram-scraper2')) {
      // instagram-scraper2 API
      return this.parseInstagramResponse(data);
    } else if (apiHost.includes('instagram-scraper-api2')) {
      // instagram-scraper-api2 API
      return this.parseInstagramResponse(data);
    } else if (apiHost.includes('instagram47')) {
      // Legacy instagram47
      return this.parseInstagram47Response(data);
    } else {
      // Default parser
      return this.parseInstagramResponse(data);
    }
  }

  parseInstagram47Response(data) {
    // Parse instagram47.p.rapidapi.com response
    const post = data.data || data;

    return {
      success: true,
      caption: post.caption || post.text || '',
      images: post.images || [],
      author: {
        username: post.owner?.username || 'unknown',
        fullName: post.owner?.full_name
      },
      hashtags: this.extractHashtags(post.caption || post.text || '')
    };
  }

  parseJunioroangelResponse(data) {
    // Parse junioroangel's Instagram Scraper response
    const post = data.data || data;

    return {
      success: true,
      caption: post.caption?.text || post.caption || '',
      images: this.extractImages(post),
      videos: this.extractVideos(post),
      author: {
        username: post.user?.username || post.owner?.username || 'unknown',
        fullName: post.user?.full_name || post.owner?.full_name,
        profilePic: post.user?.profile_pic_url || post.owner?.profile_pic_url
      },
      hashtags: this.extractHashtags(post.caption?.text || post.caption || ''),
      likes: post.like_count || 0,
      comments: post.comment_count || 0
    };
  }

  parseStableAPIResponse(data) {
    // Parse Stable API response
    const post = data.data || data.result || data;

    return {
      success: true,
      caption: post.caption || post.text || post.description || '',
      images: post.media_urls || post.images || [],
      author: {
        username: post.username || post.owner?.username || 'unknown',
        fullName: post.owner?.full_name
      },
      hashtags: this.extractHashtags(post.caption || ''),
      likes: post.likes_count || post.like_count || 0,
      comments: post.comments_count || post.comment_count || 0
    };
  }

  parseSocialScrapperResponse(data) {
    // Parse SocialScrapper API response
    const post = data.post || data.data || data;

    return {
      success: true,
      caption: post.caption || post.text || '',
      images: post.images || post.media || [],
      videos: post.videos || [],
      author: {
        username: post.user?.username || post.author || 'unknown',
        fullName: post.user?.name,
        profilePic: post.user?.profile_pic
      },
      hashtags: post.hashtags || this.extractHashtags(post.caption || ''),
      likes: post.likes || 0,
      comments: post.comment_count || 0
    };
  }

  parseInstagramResponse(data) {
    const post = data.data || data;
    
    console.log('[InstagramExtractor] Parsing response:', {
      hasCaption: !!post.caption?.text,
      captionLength: post.caption?.text?.length,
      hasImages: !!(post.image_versions2 || post.carousel_media),
      username: post.user?.username
    });
    
    const result = {
      success: true,
      url: post.code ? `https://instagram.com/p/${post.code}` : null,
      
      // Media
      images: this.extractImages(post),
      videos: this.extractVideos(post),
      
      // Content - Try multiple caption sources
      caption: post.caption?.text || post.caption || '',
      hashtags: this.extractHashtags(post.caption?.text || post.caption),
      
      // Author
      author: {
        username: post.user?.username || 'unknown',
        fullName: post.user?.full_name,
        profilePic: post.user?.profile_pic_url,
        isVerified: post.user?.is_verified || false
      },
      
      // Metadata
      likes: post.like_count || 0,
      comments: post.comment_count || 0,
      timestamp: post.taken_at ? new Date(post.taken_at * 1000) : new Date(),
      location: post.location?.name,
      
      // Post type
      isCarousel: post.carousel_media ? true : false,
      isVideo: post.media_type === 2,
      isReel: post.product_type === 'clips'
    };
    
    console.log('[InstagramExtractor] Extracted caption preview:', result.caption?.substring(0, 100));
    
    return result;
  }

  extractImages(post) {
    const images = [];
    
    // Carousel posts (multiple images)
    if (post.carousel_media && Array.isArray(post.carousel_media)) {
      post.carousel_media.forEach(media => {
        if (media.image_versions2?.candidates) {
          // Get highest quality image
          const bestImage = media.image_versions2.candidates[0];
          images.push({
            url: bestImage.url,
            width: bestImage.width,
            height: bestImage.height
          });
        }
      });
    } 
    // Single image posts
    else if (post.image_versions2?.candidates) {
      const bestImage = post.image_versions2.candidates[0];
      images.push({
        url: bestImage.url,
        width: bestImage.width,
        height: bestImage.height
      });
    }
    
    return images;
  }

  extractVideos(post) {
    if (post.video_url) {
      return [{
        url: post.video_url,
        duration: post.video_duration,
        thumbnail: post.image_versions2?.candidates?.[0]?.url
      }];
    }
    return [];
  }

  extractHashtags(caption) {
    if (!caption) return [];
    const regex = /#[\w]+/g;
    const matches = caption.match(regex) || [];
    return matches.map(tag => tag.substring(1).toLowerCase());
  }

  async tryDirectPageFetch(instagramUrl) {
    // Direct page fetch as last resort fallback
    try {
      console.log('[InstagramExtractor] Attempting direct page fetch...');

      // Extract shortcode from URL
      const shortcodeMatch = instagramUrl.match(/\/(p|reel|tv)\/([A-Za-z0-9_-]+)/);
      if (!shortcodeMatch) {
        console.log('[InstagramExtractor] Could not extract shortcode from URL');
        return { success: false };
      }

      const shortcode = shortcodeMatch[2];
      console.log(`[InstagramExtractor] Extracted shortcode: ${shortcode}`);

      // Try to fetch the page directly
      const response = await axios({
        method: 'GET',
        url: instagramUrl,
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
          'Accept-Language': 'en-US,en;q=0.5',
          'Accept-Encoding': 'gzip, deflate, br',
          'DNT': '1',
          'Connection': 'keep-alive',
          'Upgrade-Insecure-Requests': '1'
        },
        timeout: 20000,
        maxRedirects: 5
      });

      const html = response.data;

      // Try to extract JSON-LD structured data
      const jsonLdMatch = html.match(/<script type="application\/ld\+json"[^>]*>(.*?)<\/script>/s);
      if (jsonLdMatch) {
        try {
          const jsonLd = JSON.parse(jsonLdMatch[1]);
          console.log('[InstagramExtractor] Found JSON-LD data');

          return {
            success: true,
            caption: jsonLd.caption || jsonLd.description || '',
            images: jsonLd.image ? [{ url: jsonLd.image }] : [],
            videos: jsonLd.video ? [{ url: jsonLd.video }] : [],
            author: {
              username: jsonLd.author?.name || jsonLd.creator?.name || 'unknown'
            },
            hashtags: this.extractHashtags(jsonLd.caption || jsonLd.description || '')
          };
        } catch (e) {
          console.log('[InstagramExtractor] Failed to parse JSON-LD');
        }
      }

      // Try to extract from meta tags
      const metaDescription = html.match(/<meta\s+(?:property|name)="(?:og:)?description"\s+content="([^"]+)"/);
      const metaImage = html.match(/<meta\s+property="og:image"\s+content="([^"]+)"/);
      const metaVideo = html.match(/<meta\s+property="og:video"\s+content="([^"]+)"/);
      const metaTitle = html.match(/<meta\s+property="og:title"\s+content="([^"]+)"/);

      if (metaDescription || metaTitle) {
        console.log('[InstagramExtractor] Found meta tag data');

        // Extract username from title (usually format: "@username on Instagram: ...")
        let username = 'unknown';
        if (metaTitle) {
          const usernameMatch = metaTitle[1].match(/@([A-Za-z0-9_.]+)/);
          if (usernameMatch) {
            username = usernameMatch[1];
          }
        }

        // Clean up description - often starts with likes count
        let caption = metaDescription ? metaDescription[1] : '';
        // Remove likes count if present (e.g., "123 likes, ")
        caption = caption.replace(/^\d+[\s,]*(?:likes?|Me gusta|J'aime)[,\s]*/, '');
        // Remove username mentions at the start
        caption = caption.replace(/^@[A-Za-z0-9_.]+:?\s*/, '');

        return {
          success: true,
          caption: caption,
          images: metaImage ? [{ url: metaImage[1] }] : [],
          videos: metaVideo ? [{ url: metaVideo[1] }] : [],
          author: { username },
          hashtags: this.extractHashtags(caption)
        };
      }

      // Try to extract from window._sharedData (Instagram's data object)
      const sharedDataMatch = html.match(/window\._sharedData\s*=\s*({.+?});/s);
      if (sharedDataMatch) {
        try {
          const sharedData = JSON.parse(sharedDataMatch[1]);
          const media = sharedData?.entry_data?.PostPage?.[0]?.graphql?.shortcode_media ||
                       sharedData?.entry_data?.PostPage?.[0]?.media;

          if (media) {
            console.log('[InstagramExtractor] Found _sharedData');

            return {
              success: true,
              caption: media.edge_media_to_caption?.edges?.[0]?.node?.text || media.caption || '',
              images: media.display_url ? [{ url: media.display_url }] : [],
              videos: media.video_url ? [{ url: media.video_url }] : [],
              author: {
                username: media.owner?.username || 'unknown',
                fullName: media.owner?.full_name
              },
              hashtags: this.extractHashtags(media.edge_media_to_caption?.edges?.[0]?.node?.text || '')
            };
          }
        } catch (e) {
          console.log('[InstagramExtractor] Failed to parse _sharedData');
        }
      }

      console.log('[InstagramExtractor] Could not extract data from page HTML');
      return { success: false };

    } catch (error) {
      console.error('[InstagramExtractor] Direct page fetch error:', error.message);
      return { success: false, error: error.message };
    }
  }

  async checkCache(url) {
    try {
      const { data } = await this.supabase
        .from('instagram_cache')
        .select('data')
        .eq('url', url)
        .gt('expires_at', new Date().toISOString())
        .single();
      
      return data?.data || null;
    } catch (error) {
      // Cache miss or error
      return null;
    }
  }

  async cacheResult(url, data) {
    try {
      await this.supabase
        .from('instagram_cache')
        .upsert({
          url,
          data,
          expires_at: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString()
        });
    } catch (error) {
      console.error('[InstagramExtractor] Cache error:', error.message);
      // Continue without caching
    }
  }

  getErrorMessage(error) {
    if (error.response?.status === 404) return 'Post not found or deleted';
    if (error.response?.status === 401) return 'Private account or authentication required';
    if (error.response?.status === 429) return 'Rate limit exceeded - please try again later';
    if (error.code === 'ECONNABORTED') return 'Request timeout - please try again';
    return 'Failed to extract content from Instagram';
  }

  // Mock data for testing without API key
  getMockData(url) {
    return {
      success: true,
      url: url,
      images: [{
        url: 'https://images.unsplash.com/photo-1546069901-ba9599a7e63c',
        width: 1080,
        height: 1080
      }],
      videos: [],
      caption: `🍝 Creamy Garlic Parmesan Pasta

INGREDIENTS:
• 1 lb fettuccine pasta
• 4 cloves garlic, minced
• 1 cup heavy cream
• 1 cup freshly grated Parmesan cheese
• 2 tbsp butter
• 2 tbsp olive oil
• Salt and pepper to taste
• Fresh parsley for garnish

INSTRUCTIONS:
1. Cook pasta according to package directions until al dente. Reserve 1 cup pasta water before draining.
2. In a large skillet, melt butter with olive oil over medium heat.
3. Add minced garlic and sauté for 1 minute until fragrant.
4. Pour in heavy cream and bring to a gentle simmer.
5. Add Parmesan cheese and stir until melted and smooth.
6. Add cooked pasta to the sauce and toss to combine.
7. Add pasta water as needed to reach desired consistency.
8. Season with salt and pepper.
9. Garnish with fresh parsley and extra Parmesan.

Ready in 20 minutes! Perfect for weeknight dinners 🌟

#pasta #italianfood #easyrecipes #dinnerideas #comfortfood #homecooking`,
      hashtags: ['pasta', 'italianfood', 'easyrecipes', 'dinnerideas', 'comfortfood', 'homecooking'],
      author: {
        username: 'testfoodblogger',
        fullName: 'Test Food Blogger',
        profilePic: 'https://ui-avatars.com/api/?name=Food+Blogger',
        isVerified: true
      },
      likes: 1234,
      comments: 56,
      timestamp: new Date(),
      location: null,
      isCarousel: false,
      isVideo: false,
      isReel: false
    };
  }
}

module.exports = InstagramExtractor;