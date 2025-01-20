// File: functions/discord-bot/index.js

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js";

const DISCORD_BOT_TOKEN = Deno.env.get("DISCORD_BOT_TOKEN");
const CHANNEL_ID = Deno.env.get("CHANNEL_ID");
const SUPABASE_URL = Deno.env.get("SUPABASE_URL");
const SUPABASE_ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY");

const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

/**
 * Helper: Remove non-alphanumeric chars and unify the string
 */
function toNoSpace(str) {
  return str.replace(/\W+/g, "");
}

/**
 * Utility to group an array of objects by a specific key.
 */
function groupBy(array, key) {
  return array.reduce((acc, obj) => {
    const val = obj[key] || "UnknownTheme";
    acc[val] = acc[val] || [];
    acc[val].push(obj);
    return acc;
  }, {});
}

/**
 * Edge Function Handler
 */
serve(async (req) => {
  if (req.method === "POST") {
    const interaction = await req.json();

    if (interaction.type === 2) { // InteractionType.APPLICATION_COMMAND
      const { name, options } = interaction.data;

      if (name === "get_runway_images") {
        const seasonOpt = options?.find(opt => opt.name === "season");
        const seasonNumber = seasonOpt ? parseInt(seasonOpt.value, 10) : 17;

        try {
          const responseMessage = await handleRunwayImagesRequest(seasonNumber);
          return new Response(
            JSON.stringify({ type: 4, data: { content: responseMessage } }),
            { headers: { "Content-Type": "application/json" }, status: 200 }
          );
        } catch (err) {
          console.error("Error handling runway images:", err);
          return new Response(
            JSON.stringify({ type: 4, data: { content: "An error occurred fetching runway images." } }),
            { headers: { "Content-Type": "application/json" }, status: 200 }
          );
        }
      }
    }

    return new Response("ok", { status: 200 });
  }

  return new Response("Hello from Discord Bot", { status: 200 });
});

/**
 * Handle the `/get_runway_images` command
 */
async function handleRunwayImagesRequest(seasonNumber) {
  const cachedUrls = await getImagesFromCache(seasonNumber);
  const allRunwayData = await getSeasonRunwayImages(seasonNumber);
  const newRunwayData = allRunwayData.filter(obj => !cachedUrls.includes(obj.imageUrl));

  if (!newRunwayData.length) {
    return `No new images found for Season ${seasonNumber}.`;
  }

  await cacheImagesInSupabase(seasonNumber, newRunwayData);
  const dataByTheme = groupBy(newRunwayData, "runway_theme");

  for (const theme in dataByTheme) {
    const items = dataByTheme[theme];
    const threadTitle = `${theme || "Untitled"} (Season ${seasonNumber})`;
    const themeUrls = items.map(i => i.imageUrl);

    await createThreadAndPostImages(threadTitle, themeUrls);
  }

  return `Posted **${newRunwayData.length}** new images for Season ${seasonNumber} (grouped by runway theme).`;
}

/**
 * Supabase: Fetch cached image URLs
 */
async function getImagesFromCache(season) {
  const { data, error } = await supabase
    .from("season_runways")
    .select("image_url")
    .eq("season", season);

  if (error) {
    console.error("Error reading runway images from Supabase:", error);
    return [];
  }

  return data.map(row => row.image_url);
}

/**
 * Supabase: Cache new images
 */
async function cacheImagesInSupabase(season, runwayData) {
  const inserts = runwayData.map(item => ({
    season,
    image_url: item.imageUrl,
    contestant_name: item.contestant_name,
    runway_theme: item.runway_theme
  }));

  const { error } = await supabase.from("season_runways").insert(inserts);

  if (error) {
    console.error("Error inserting runway images:", error);
  }
}

/**
 * Fetch season contestants from Supabase
 */
async function getContestantsForSeason(season) {
  const { data, error } = await supabase
    .from("season_contestants")
    .select("name")
    .eq("season", season);

  if (error) {
    console.error("Error fetching contestants:", error);
    return [];
  }

  return data.map(row => row.name);
}

/**
 * Discord: Create thread and post images
 */
async function createThreadAndPostImages(threadTitle, imageUrls) {
  const threadResponse = await fetch(`https://discord.com/api/channels/${CHANNEL_ID}/threads`, {
    method: "POST",
    headers: {
      Authorization: `Bot ${DISCORD_BOT_TOKEN}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      name: threadTitle,
      type: 11, // GUILD_PUBLIC_THREAD
      auto_archive_duration: 60
    })
  });

  const threadData = await threadResponse.json();
  const threadId = threadData.id;

  for (const url of imageUrls) {
    await fetch(`https://discord.com/api/channels/${threadId}/messages`, {
      method: "POST",
      headers: {
        Authorization: `Bot ${DISCORD_BOT_TOKEN}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({ content: url })
    });
  }
}

/**
 * Fetch runway images from Fandom
 */
async function getSeasonRunwayImages(season) {
  const contestants = await getContestantsForSeason(season);
  const pageName = `RuPaul's_Drag_Race_(Season_${season})/Looks`;
  let allFileTitles = [];
  let imcontinue = null;

  do {
    const { fileTitles, nextContinue } = await fetchFileTitles(pageName, imcontinue);
    allFileTitles = allFileTitles.concat(fileTitles);
    imcontinue = nextContinue;
  } while (imcontinue);

  const runwayData = [];
  for (const fileTitle of allFileTitles) {
    const { contestant_name, runway_theme } = parseFileTitle(fileTitle, contestants);
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

async function getFileUrl(fileTitle) {
  const endpoint = "https://rupaulsdragrace.fandom.com/api.php";
  const params = new URLSearchParams({
    action: "query",
    titles: fileTitle,
    prop: "imageinfo",
    iiprop: "url",
    format: "json",
    formatversion: "2"
  });

  const res = await fetch(`${endpoint}?${params.toString()}`);
  const data = await res.json();
  const page = data?.query?.pages?.[0];
  return page?.imageinfo?.[0]?.url || null;
}

async function fetchFileTitles(pageName, imcontinue) {
  const endpoint = "https://rupaulsdragrace.fandom.com/api.php";
  const params = new URLSearchParams({
    action: "query",
    prop: "images",
    titles: pageName,
    format: "json",
    formatversion: "2"
  });

  if (imcontinue) {
    params.append("imcontinue", imcontinue);
  }

  const res = await fetch(`${endpoint}?${params.toString()}`);
  const data = await res.json();
  const images = data?.query?.pages?.[0]?.images || [];
  const fileTitles = images.map(img => img.title);

  return { fileTitles, nextContinue: data?.continue?.imcontinue || null };
}

function parseFileTitle(fileTitle, contestants) {
  let bare = fileTitle.replace(/^File:/, "").replace(/\.(jpg|jpeg|png|gif)$/i, "").replace(/Look$/i, "");

  for (const c of contestants) {
    const cNoSpace = toNoSpace(c);
    if (bare.startsWith(cNoSpace)) {
      const theme = bare.substring(cNoSpace.length);
      return { contestant_name: c, runway_theme: theme || null };
    }
  }

  return { contestant_name: null, runway_theme: bare };
}
