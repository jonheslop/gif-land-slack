interface Gif {
  id: number;
  url: string;
  tags: string;
  width: number;
  height: number;
}

interface Env {
  SLACK_SIGNING_SECRET: string;
  SLACK_CLIENT_ID: string;
  SLACK_CLIENT_SECRET: string;
  SLACK_REDIRECT_URI: string;
  SLACK_KV: KVNamespace;
}

interface OAuthResponse {
  ok: boolean;
  access_token: string;
  team: { id: string; name: string };
  error?: string;
}

const SITE_URL = "https://gif.land";
const MAX_GIFS_SHOWN = 10;

async function verifySlackSignature(
  signingSecret: string,
  timestamp: string,
  body: string,
  signature: string,
): Promise<boolean> {
  const now = Math.floor(Date.now() / 1000);
  if (Math.abs(now - parseInt(timestamp, 10)) > 300) return false;

  const baseString = `v0:${timestamp}:${body}`;
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(signingSecret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const mac = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(baseString),
  );
  const hex = [...new Uint8Array(mac)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  return `v0=${hex}` === signature;
}

function jsonResponse(body: object, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

async function fetchGifs(): Promise<Gif[]> {
  const res = await fetch(`${SITE_URL}/api`);
  if (!res.ok) throw new Error(`Failed to fetch GIFs: ${res.status}`);
  return res.json();
}

function buildGifBlocks(gifs: Gif[]): object[] {
  const blocks: object[] = [];
  for (const gif of gifs) {
    const gifUrl = `${SITE_URL}/${gif.url}`;
    const label = gif.tags || gif.url.replace(/\.gif$/i, "");
    blocks.push({
      type: "image",
      image_url: gifUrl,
      alt_text: label,
      title: { type: "plain_text", text: label },
    });
    blocks.push({
      type: "actions",
      elements: [
        {
          type: "button",
          text: { type: "plain_text", text: "Share to channel" },
          value: JSON.stringify({ url: gif.url, tags: gif.tags || "" }),
          action_id: "share_gif",
          style: "primary",
        },
      ],
    });
  }
  return blocks;
}

async function handleInstall(request: Request, env: Env): Promise<Response> {
  const state = crypto.randomUUID();
  await env.SLACK_KV.put(`state:${state}`, "1", { expirationTtl: 600 });

  const params = new URLSearchParams({
    client_id: env.SLACK_CLIENT_ID,
    scope: "commands",
    redirect_uri: env.SLACK_REDIRECT_URI,
    state,
  });

  return Response.redirect(
    `https://slack.com/oauth/v2/authorize?${params}`,
    302,
  );
}

async function handleOAuthRedirect(
  request: Request,
  env: Env,
): Promise<Response> {
  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");

  if (!code || !state) {
    return new Response("Missing code or state", { status: 400 });
  }

  const valid = await env.SLACK_KV.get(`state:${state}`);
  if (!valid) {
    return new Response("Invalid or expired state", { status: 403 });
  }
  await env.SLACK_KV.delete(`state:${state}`);

  const tokenRes = await fetch("https://slack.com/api/oauth.v2.access", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      client_id: env.SLACK_CLIENT_ID,
      client_secret: env.SLACK_CLIENT_SECRET,
      redirect_uri: env.SLACK_REDIRECT_URI,
    }),
  });

  const data = (await tokenRes.json()) as OAuthResponse;

  if (!data.ok) {
    return new Response(`OAuth failed: ${data.error}`, { status: 500 });
  }

  await env.SLACK_KV.put(`token:${data.team.id}`, data.access_token);

  return new Response(
    "｡◕‿◕｡\ngif.land has been added to your Slack workspace!\nyou can now use /gifland to add gifs\nYou can close this tab.",
    { status: 200, headers: { "Content-Type": "text/plain" } },
  );
}

async function handleSlashCommand(
  request: Request,
  env: Env,
): Promise<Response> {
  const body = await request.text();
  const timestamp = request.headers.get("X-Slack-Request-Timestamp") ?? "";
  const signature = request.headers.get("X-Slack-Signature") ?? "";

  if (
    !(await verifySlackSignature(
      env.SLACK_SIGNING_SECRET,
      timestamp,
      body,
      signature,
    ))
  ) {
    return new Response("Unauthorized", { status: 401 });
  }

  const params = new URLSearchParams(body);
  const text = (params.get("text") ?? "").trim();

  let allGifs: Gif[];
  try {
    allGifs = await fetchGifs();
  } catch {
    return jsonResponse({
      response_type: "ephemeral",
      text: "Could not reach gif.land right now. Try again in a moment.",
    });
  }

  if (!text) {
    // No search term - post a random GIF directly to channel
    const gif = allGifs[Math.floor(Math.random() * allGifs.length)];
    const gifUrl = `${SITE_URL}/${gif.url}`;
    const label = `${gif.url}${gif.tags ? ` | ${gif.tags}` : ""}`;
    return jsonResponse({
      response_type: "in_channel",
      blocks: [
        {
          type: "image",
          image_url: gifUrl,
          alt_text: label,
          title: { type: "plain_text", text: label },
        },
      ],
    });
  }

  const query = text.toLowerCase();
  const matches = allGifs.filter(
    (g) =>
      g.tags?.toLowerCase().includes(query) ||
      g.url.toLowerCase().includes(query),
  );

  if (matches.length === 0) {
    return jsonResponse({
      response_type: "ephemeral",
      text: `No GIFs found for "${text}". Try a different search.`,
    });
  }

  const shown = matches.slice(0, MAX_GIFS_SHOWN);
  const headerText =
    matches.length > MAX_GIFS_SHOWN
      ? `Showing ${MAX_GIFS_SHOWN} of ${matches.length} GIFs for *${text}* — try a more specific search to see fewer results.`
      : `Found ${matches.length} GIF${matches.length === 1 ? "" : "s"} for *${text}*`;

  return jsonResponse({
    response_type: "ephemeral",
    blocks: [
      { type: "section", text: { type: "mrkdwn", text: headerText } },
      ...buildGifBlocks(shown),
    ],
  });
}

async function handleAction(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
): Promise<Response> {
  const body = await request.text();
  const timestamp = request.headers.get("X-Slack-Request-Timestamp") ?? "";
  const signature = request.headers.get("X-Slack-Signature") ?? "";

  if (
    !(await verifySlackSignature(
      env.SLACK_SIGNING_SECRET,
      timestamp,
      body,
      signature,
    ))
  ) {
    return new Response("Unauthorized", { status: 401 });
  }

  const params = new URLSearchParams(body);
  const payload = JSON.parse(params.get("payload") ?? "{}");

  const action = payload.actions?.[0];
  if (!action || action.action_id !== "share_gif") {
    return new Response("OK", { status: 200 });
  }

  let gifFilename: string;
  let tags: string;
  try {
    const parsed = JSON.parse(action.value);
    gifFilename = parsed.url;
    tags = parsed.tags || "";
  } catch {
    gifFilename = action.value;
    tags = "";
  }
  const gifUrl = `${SITE_URL}/${gifFilename}`;
  const label = `${gifFilename}${tags ? ` | ${tags}` : ""}`;
  const responseUrl: string = payload.response_url;

  // Delete the ephemeral picker and post the GIF publicly to the channel
  ctx.waitUntil(
    fetch(responseUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        response_type: "in_channel",
        delete_original: true,
        blocks: [
          {
            type: "image",
            image_url: gifUrl,
            alt_text: label,
            title: { type: "plain_text", text: label },
          },
        ],
      }),
    }),
  );

  // Acknowledge the action
  return new Response("", { status: 200 });
}

export default {
  async fetch(
    request: Request,
    env: Env,
    ctx: ExecutionContext,
  ): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === "GET") {
      if (url.pathname === "/slack/install") {
        return handleInstall(request, env);
      }
      if (url.pathname === "/slack/oauth_redirect") {
        return handleOAuthRedirect(request, env);
      }
      return new Response("Not found", { status: 404 });
    }

    if (request.method !== "POST") {
      return new Response("Method not allowed", { status: 405 });
    }

    if (url.pathname === "/slack") {
      return handleSlashCommand(request, env);
    }

    if (url.pathname === "/slack/action") {
      return handleAction(request, env, ctx);
    }

    return new Response("Not found", { status: 404 });
  },
};
