import fetch from "node-fetch";
import dotenv from "dotenv";

// Load environment variables
dotenv.config();

const DISCORD_BOT_TOKEN = process.env.DISCORD_BOT_TOKEN;
const CLIENT_ID = process.env.CLIENT_ID; // Your bot's application ID
const GUILD_ID = process.env.GUILD_ID; // Optional: Your server (guild) ID for guild-specific commands

/**
 * List of slash commands to register
 */
const commands = [
  {
    name: "get_runway_images",
    description: "Fetch runway images for a given season",
    options: [
      {
        name: "season",
        type: 4, // INTEGER
        description: "The season number (e.g., 17)",
        required: false,
      },
    ],
  },
];

/**
 * Register slash commands with Discord API
 */
async function registerCommands() {
  const url = GUILD_ID
    ? `https://discord.com/api/v10/applications/${CLIENT_ID}/guilds/${GUILD_ID}/commands`
    : `https://discord.com/api/v10/applications/${CLIENT_ID}/commands`; // Global commands

  try {
    const response = await fetch(url, {
      method: "PUT", // Use PUT to overwrite existing commands
      headers: {
        "Authorization": `Bot ${DISCORD_BOT_TOKEN}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(commands),
    });

    if (response.ok) {
      console.log("Slash commands registered successfully!");
    } else {
      console.error("Failed to register commands:", await response.text());
    }
  } catch (err) {
    console.error("Error registering commands:", err);
  }
}

registerCommands();
