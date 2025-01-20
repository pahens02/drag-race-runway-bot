import fetch from "node-fetch";
import nacl from "tweetnacl";

const DISCORD_PUBLIC_KEY = process.env.DISCORD_PUBLIC_KEY; // Set in Vercel Environment Variables
const SUPABASE_EDGE_FUNCTION_URL = process.env.SUPABASE_EDGE_FUNCTION_URL;

/**
 * Verify that the request comes from Discord.
 */
function verifyDiscordRequest(request) {
  const signature = request.headers["x-signature-ed25519"];
  const timestamp = request.headers["x-signature-timestamp"];
  const body = request.body || "{}";

  const isValid = nacl.sign.detached.verify(
    Buffer.from(timestamp + body),
    Buffer.from(signature, "hex"),
    Buffer.from(DISCORD_PUBLIC_KEY, "hex")
  );

  if (!isValid) {
    throw new Error("Invalid Discord request signature.");
  }
}

export default async function handler(req, res) {
  if (req.method === "POST") {
    try {
      // Verify Discord Request
      verifyDiscordRequest(req);

      // Forward the interaction to the Supabase Edge Function
      const response = await fetch(SUPABASE_EDGE_FUNCTION_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(req.body),
      });

      const data = await response.json();

      // Send the response back to Discord
      return res.status(200).json(data);
    } catch (error) {
      console.error("Error handling Discord request:", error);
      return res.status(401).send("Unauthorized");
    }
  }

  res.status(405).send("Method Not Allowed");
}
