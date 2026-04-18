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
const MAX_MODAL_RESULTS = 10;

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

function shuffled<T>(arr: T[]): T[] {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
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

// Builds the first modal view: a single search input.
function buildSearchModal(meta: {
  channelId: string;
  threadTs: string;
}): object {
  return {
    type: "modal",
    callback_id: "gifland_search",
    private_metadata: JSON.stringify(meta),
    title: { type: "plain_text", text: "gif.land" },
    submit: { type: "plain_text", text: "Search" },
    close: { type: "plain_text", text: "Cancel" },
    blocks: [
      {
        type: "input",
        block_id: "search_block",
        label: { type: "plain_text", text: "Search for a GIF" },
        hint: {
          type: "plain_text",
          text: "Leave blank for a random selection.",
        },
        element: {
          type: "plain_text_input",
          action_id: "search_input",
          placeholder: { type: "plain_text", text: "cats, celebration, wave…" },
        },
        optional: true,
      },
    ],
  };
}

// Builds the second modal view: image previews with a "Post" button under each.
function buildResultsModal(
  meta: { channelId: string; threadTs: string },
  gifs: Gif[],
): object {
  const blocks: object[] = [];
  for (const gif of gifs) {
    const gifUrl = `${SITE_URL}/${gif.url}`;
    const label = gif.tags || gif.url.replace(/\.gif$/i, "");
    blocks.push({
      type: "image",
      image_url: gifUrl,
      alt_text: label,
      title: { type: "plain_text", text: gif.url },
    });
    blocks.push({
      type: "actions",
      elements: [
        {
          type: "button",
          text: { type: "plain_text", text: "Post to thread" },
          value: `${gif.url}||${gif.tags || ""}`.slice(0, 150),
          action_id: "post_gif_to_thread",
          style: "primary",
        },
      ],
    });
  }
  return {
    type: "modal",
    callback_id: "gifland_results",
    private_metadata: JSON.stringify(meta),
    title: { type: "plain_text", text: "gif.land" },
    close: { type: "plain_text", text: "Back" },
    blocks,
  };
}

async function handleInstall(request: Request, env: Env): Promise<Response> {
  const state = crypto.randomUUID();
  await env.SLACK_KV.put(`state:${state}`, "1", { expirationTtl: 600 });

  const params = new URLSearchParams({
    client_id: env.SLACK_CLIENT_ID,
    scope: "commands,chat:write,chat:write.public",
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
    "｡◕‿◕｡\ngif.land has been added to your Slack workspace!\nYou can now use /gifland to add gifs\nThanks",
    { status: 200, headers: { "Content-Type": "text/plain; charset=utf-8" } },
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

  const userId = params.get("user_id") ?? "";

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
        {
          type: "context",
          elements: [
            { type: "mrkdwn", text: `Summond by <@${userId}>` },
          ],
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

// Handles the message shortcut: opens the search modal in the thread's context.
async function handleMessageShortcut(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  payload: Record<string, any>,
  env: Env,
  ctx: ExecutionContext,
): Promise<Response> {
  const teamId: string = payload.team.id;
  const triggerId: string = payload.trigger_id;
  const channelId: string = payload.channel.id;
  const message: { ts: string; thread_ts?: string } = payload.message;
  // If the shortcut was triggered inside a thread, thread_ts is the root message.
  // Otherwise use the message's own ts so a reply thread is created.
  const threadTs = message.thread_ts ?? message.ts;

  const token = await env.SLACK_KV.get(`token:${teamId}`);
  if (!token) {
    return new Response("App not installed for this workspace", {
      status: 403,
    });
  }

  ctx.waitUntil(
    fetch("https://slack.com/api/views.open", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        trigger_id: triggerId,
        view: buildSearchModal({ channelId, threadTs }),
      }),
    }),
  );

  return new Response("", { status: 200 });
}

// Handles the search modal submission: fetch gifs, push the visual results view.
async function handleViewSubmission(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  payload: Record<string, any>,
  env: Env,
  ctx: ExecutionContext,
): Promise<Response> {
  const callbackId: string = payload.view.callback_id;
  const meta: { channelId: string; threadTs: string } = JSON.parse(
    payload.view.private_metadata || "{}",
  );

  if (callbackId === "gifland_search") {
    const query: string = (
      payload.view.state.values?.search_block?.search_input?.value ?? ""
    ).trim();

    let allGifs: Gif[];
    try {
      allGifs = await fetchGifs();
    } catch {
      return jsonResponse({
        response_action: "errors",
        errors: {
          search_block: "Could not reach gif.land. Try again in a moment.",
        },
      });
    }

    const matches = query
      ? allGifs.filter(
        (g) =>
          g.tags?.toLowerCase().includes(query.toLowerCase()) ||
          g.url.toLowerCase().includes(query.toLowerCase()),
      )
      : shuffled(allGifs).slice(0, MAX_MODAL_RESULTS);

    if (matches.length === 0) {
      return jsonResponse({
        response_action: "errors",
        errors: {
          search_block: `No GIFs found for "${query}". Try a different search.`,
        },
      });
    }

    return jsonResponse({
      response_action: "push",
      view: buildResultsModal(meta, matches.slice(0, MAX_MODAL_RESULTS)),
    });
  }

  return new Response("OK", { status: 200 });
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

  // Dispatch based on payload type
  if (payload.type === "message_action") {
    return handleMessageShortcut(payload, env, ctx);
  }

  if (payload.type === "view_submission") {
    return handleViewSubmission(payload, env, ctx);
  }

  // block_actions
  const action = payload.actions?.[0];
  if (!action) {
    return new Response("OK", { status: 200 });
  }

  // "Post to thread" button clicked inside the results modal
  if (action.action_id === "post_gif_to_thread" && payload.view) {
    const meta: { channelId: string; threadTs: string } = JSON.parse(
      payload.view.private_metadata || "{}",
    );
    const [selectedUrl, tags = ""] = (action.value as string).split("||", 2);
    const teamId: string = payload.team.id;
    const userId: string = payload.user?.id ?? "";
    const token = await env.SLACK_KV.get(`token:${teamId}`);
    if (!token) {
      return new Response("App not installed for this workspace", {
        status: 403,
      });
    }

    const gifUrl = `${SITE_URL}/${selectedUrl}`;
    const label = `${selectedUrl}${tags ? ` | ${tags}` : ""}`;

    // Post the gif, then update the modal with success or error
    ctx.waitUntil(
      (async () => {
        const postRes = await fetch("https://slack.com/api/chat.postMessage", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${token}`,
          },
          body: JSON.stringify({
            channel: meta.channelId,
            thread_ts: meta.threadTs,
            blocks: [
              {
                type: "image",
                image_url: gifUrl,
                alt_text: label,
                title: { type: "plain_text", text: label },
              },
              {
                type: "context",
                elements: [
                  { type: "mrkdwn", text: `Summond by <@${userId}>` },
                ],
              },
            ],
          }),
        });
        const postData = (await postRes.json()) as {
          ok: boolean;
          error?: string;
        };

        const confirmText = postData.ok
          ? "GIF posted!"
          : `Failed to post: ${postData.error}`;

        await fetch("https://slack.com/api/views.update", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${token}`,
          },
          body: JSON.stringify({
            view_id: payload.view.id,
            view: {
              type: "modal",
              title: { type: "plain_text", text: "gif.land" },
              close: { type: "plain_text", text: "Done" },
              blocks: [
                {
                  type: "section",
                  text: { type: "mrkdwn", text: confirmText },
                },
              ],
            },
          }),
        });
      })(),
    );

    return new Response("", { status: 200 });
  }

  // "Share to channel" button in the slash command ephemeral picker
  if (action.action_id !== "share_gif") {
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
  const userId: string = payload.user?.id ?? "";

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
          {
            type: "context",
            elements: [
              { type: "mrkdwn", text: `Summoned by <@${userId}>` },
            ],
          },
        ],
      }),
    }),
  );

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
