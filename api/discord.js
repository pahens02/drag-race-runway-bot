// File: api/discord.js
import { InteractionType } from 'discord-interactions';
import axios from 'axios';

// -------------- DISCORD --------------
const DISCORD_BOT_TOKEN = process.env.DISCORD_BOT_TOKEN;
const CHANNEL_ID = process.env.CHANNEL_ID; // The channel where you’ll create threads

// -------------- SUPABASE --------------
import { createClient } from '@supabase/supabase-js';
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY);

/**
 * Helper: remove non-alphanumeric chars and unify the string
 * (e.g., "Acacia Forgot" → "AcaciaForgot").
 */
function toNoSpace(str) {
  return str.replace(/\W+/g, '');
}

/**
 * Utility to group an array of objects by a specific key.
 * Example usage: groupBy(newRunwayData, 'runway_theme')
 */
function groupBy(array, key) {
  return array.reduce((acc, obj) => {
    const val = obj[key] || 'UnknownTheme';
    acc[val] = acc[val] || [];
    acc[val].push(obj);
    return acc;
  }, {});
}

// -------------- HANDLER --------------
export default async function handler(req, res) {
  if (req.method === 'POST') {
    const interaction = req.body;

    // Check if this is a slash command
    if (interaction.type === InteractionType.APPLICATION_COMMAND) {
      const { name, options } = interaction.data;

      // slash command: /get_runway_images <season>
      if (name === 'get_runway_images') {
        // 1) Read season input from slash command
        const seasonOpt = options?.find(opt => opt.name === 'season');
        const seasonNumber = seasonOpt ? parseInt(seasonOpt.value, 10) : 17; // default 17 if not provided

        try {
          const responseMessage = await handleRunwayImagesRequest(seasonNumber);
          return res.status(200).json({
            type: 4, // CHANNEL_MESSAGE_WITH_SOURCE
            data: { content: responseMessage }
          });
        } catch (err) {
          console.error('Error handling runway images:', err);
          return res.status(200).json({
            type: 4,
            data: { content: 'An error occurred fetching runway images.' }
          });
        }
      }
    }

    // If not the slash command we’re looking for
    return res.status(200).send('ok');
  }

  // For GET or other methods
  return res.status(200).send('Hello from Discord Bot');
}

// -------------- MAIN LOGIC --------------

/**
 * Orchestrates the logic:
 *   1) Check existing images from DB (cache).
 *   2) Fetch all from Fandom (parsing using the season's contestants).
 *   3) Determine which are new (by URL).
 *   4) If none new => "No new images!"
 *   5) If new => Insert them; group by runway theme; create a thread per theme
 */
async function handleRunwayImagesRequest(seasonNumber) {
  // 1) Which images are already in our DB?
  const cachedUrls = await getImagesFromCache(seasonNumber);

  // 2) Fetch the new runway data from Fandom
  //    (which includes {imageUrl, contestant_name, runway_theme})
  const allRunwayData = await getSeasonRunwayImages(seasonNumber);

  // 3) Filter out any that are already in our DB
  const newRunwayData = allRunwayData.filter(obj => !cachedUrls.includes(obj.imageUrl));

  if (!newRunwayData.length) {
    // No new images
    return `No new images found for Season ${seasonNumber}.`;
  }

  // 4) Insert new images into Supabase
  await cacheImagesInSupabase(seasonNumber, newRunwayData);

  // 5) Group by runway_theme, then create a separate thread for each
  const dataByTheme = groupBy(newRunwayData, 'runway_theme');

  for (const theme of Object.keys(dataByTheme)) {
    const items = dataByTheme[theme];
    // The thread title is the runway theme + season
    const threadTitle = `${theme || 'Untitled'} (Season ${seasonNumber})`;
    // Grab just the image URLs
    const themeUrls = items.map(i => i.imageUrl);

    // Create a new thread named for the theme, post those images
    await createThreadAndPostImages(threadTitle, themeUrls);
  }

  return `Posted **${newRunwayData.length}** new images for Season ${seasonNumber} (grouped by runway theme).`;
}

// -------------- SUPABASE HELPERS --------------

/**
 * Return all stored image URLs for a given season
 * from the new "season_runways" table.
 */
async function getImagesFromCache(season) {
  const { data, error } = await supabase
    .from('season_runways')
    .select('image_url')
    .eq('season', season);

  if (error) {
    console.error('Error reading runway images from Supabase:', error);
    return [];
  }
  return data.map(row => row.image_url);
}

/**
 * Insert an array of runway data objects into "season_runways".
 */
async function cacheImagesInSupabase(season, runwayData) {
  // runwayData: Array<{ imageUrl, contestant_name, runway_theme }>
  const inserts = runwayData.map(item => ({
    season,
    image_url: item.imageUrl,
    contestant_name: item.contestant_name,
    runway_theme: item.runway_theme
  }));

  const { data, error } = await supabase
    .from('season_runways')
    .insert(inserts);

  if (error) {
    console.error('Error inserting runway images:', error);
  } else {
    console.log('Successfully inserted runway images:', data);
  }
}

/**
 * Gets all contestant names from the `season_contestants` table for the given season.
 */
async function getContestantsForSeason(season) {
  const { data, error } = await supabase
    .from('season_contestants')
    .select('name')
    .eq('season', season);

  if (error) {
    console.error('Error fetching contestants:', error);
    return [];
  }
  // e.g., [ { name: "Arrietty" }, { name: "Acacia Forgot" }, ... ]
  return data.map(row => row.name);
}

// -------------- DISCORD HELPERS --------------

async function createThreadAndPostImages(threadTitle, imageUrls) {
  // Create a new public thread in the channel
  const thread = await axios.post(
    `https://discord.com/api/channels/${CHANNEL_ID}/threads`,
    {
      name: threadTitle,
      type: 11, // GUILD_PUBLIC_THREAD
      auto_archive_duration: 60
    },
    {
      headers: {
        Authorization: `Bot ${DISCORD_BOT_TOKEN}`,
        'Content-Type': 'application/json'
      }
    }
  );

  const threadId = thread.data.id;

  // Post each image in the new thread
  for (const url of imageUrls) {
    await axios.post(
      `https://discord.com/api/channels/${threadId}/messages`,
      { content: url },
      {
        headers: {
          Authorization: `Bot ${DISCORD_BOT_TOKEN}`,
          'Content-Type': 'application/json'
        }
      }
    );
  }
}

// -------------- FANDOM MEDIAWIKI FETCHING --------------

async function getSeasonRunwayImages(season) {
  // 1) get the list of contestants from Supabase
  const contestants = await getContestantsForSeason(season);

  // 2) build page name, e.g. "RuPaul's_Drag_Race_(Season_17)/Looks"
  const pageName = `RuPaul's_Drag_Race_(Season_${season})/Looks`;

  // 3) gather all "File:..." titles from the page
  let allFileTitles = [];
  let imcontinue = null;

  do {
    const { fileTitles, nextContinue } = await fetchFileTitles(pageName, imcontinue);
    allFileTitles = allFileTitles.concat(fileTitles);
    imcontinue = nextContinue;
  } while (imcontinue);

  // 4) For each file, parse the name & get direct URL
  const runwayData = [];
  for (const fileTitle of allFileTitles) {
    const { contestant_name, runway_theme } = parseFileTitle(fileTitle, contestants);

    // get direct URL
    const directUrl = await getFileUrl(fileTitle);
    if (directUrl) {
      runwayData.push({
        imageUrl: directUrl,
        contestant_name,
        runway_theme
      });
    }
  }

  return runwayData;
}

/**
 * For a single file title (e.g., "File:AcaciaForgotTalentShowLook.jpg"),
 * get the direct URL (e.g., "https://static.wikia.nocookie.net/...").
 */
async function getFileUrl(fileTitle) {
  const endpoint = 'https://rupaulsdragrace.fandom.com/api.php';

  const params = {
    action: 'query',
    titles: fileTitle,
    prop: 'imageinfo',
    iiprop: 'url',
    format: 'json',
    formatversion: 2
  };

  const { data } = await axios.get(endpoint, { params });
  const page = data?.query?.pages?.[0];
  const imageinfo = page?.imageinfo?.[0];
  return imageinfo?.url || null;
}

/**
 * Recursively fetches 'images' from the Fandom wiki page with prop=images.
 * Because of pagination, we'll keep calling until there's no `imcontinue`.
 */
async function fetchFileTitles(pageName, imcontinue) {
  const endpoint = 'https://rupaulsdragrace.fandom.com/api.php';

  const params = {
    action: 'query',
    prop: 'images',
    titles: pageName,
    format: 'json',
    formatversion: 2
  };

  if (imcontinue) {
    params.imcontinue = imcontinue;
  }

  const { data } = await axios.get(endpoint, { params });
  if (!data?.query?.pages?.length) {
    return { fileTitles: [], nextContinue: null };
  }

  const images = data.query.pages[0].images || [];
  const fileTitles = images.map(img => img.title);

  let nextContinue = null;
  if (data.continue && data.continue.imcontinue) {
    nextContinue = data.continue.imcontinue;
  }
  return { fileTitles, nextContinue };
}

/**
 * Parse the file name into { contestant_name, runway_theme }
 * using the array of contestants from Supabase.
 */
function parseFileTitle(fileTitle, seasonContestants) {
  // Remove "File:" prefix
  let bare = fileTitle.replace(/^File:/, '');
  // Remove extension
  bare = bare.replace(/\.(jpg|jpeg|png|gif)$/i, '');
  // Remove trailing "Look"
  bare = bare.replace(/Look$/i, '');

  // Attempt to match a known contestant
  for (const c of seasonContestants) {
    const cNoSpace = toNoSpace(c);
    if (bare.startsWith(cNoSpace)) {
      // The remainder is the runway theme
      const theme = bare.substring(cNoSpace.length);
      return {
        contestant_name: c, // original spaced name
        runway_theme: theme || null
      };
    }
  }

  // If no match found, fallback:
  return { contestant_name: null, runway_theme: bare };
}
