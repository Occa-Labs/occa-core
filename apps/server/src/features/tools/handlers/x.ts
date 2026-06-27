// X (Twitter) tool handler.
//
// Authentication: OAuth 1.0a User Context. The 4 strings (API Key, API
// Secret, Access Token, Access Token Secret) are issued by X's developer
// portal under the project's app. Posts are made AS the X account that
// issued the Access Token (the bot account).
//
// Endpoint: POST https://api.twitter.com/2/tweets with a JSON body. Since
// the body is JSON (not application/x-www-form-urlencoded), body params
// are NOT included in the OAuth signature base string. Only the oauth_*
// params do.

import { createHmac, randomBytes } from "node:crypto";
import { z } from "zod";
import type { ToolHandler, ToolInvokeResult } from "../domain/types";

const X_TWEET_URL = "https://api.twitter.com/2/tweets";

// Max characters per post. 280 is the standard ceiling; an X Premium
// (verified) account can post up to 25,000 via the same /2/tweets endpoint
// (a "note tweet" — no special param, X promotes it automatically). The
// configured account here is Premium, so we allow the higher ceiling; the
// API still rejects >280 if the account ever loses Premium.
const MAX_TWEET_CHARS = 25000;

const credentialsSchema = z.object({
  apiKey: z.string().min(1),
  apiSecret: z.string().min(1),
  accessToken: z.string().min(1),
  accessTokenSecret: z.string().min(1),
});

type XCredentials = z.infer<typeof credentialsSchema>;

const tweetInputSchema = z.object({
  text: z.string().min(1).max(MAX_TWEET_CHARS),
});

const tweetOutputSchema = z.object({
  tweetId: z.string(),
  url: z.string().url(),
});

// RFC 3986 percent-encode. JavaScript's encodeURIComponent leaves a few
// reserved chars unencoded (!, ', (, ), *) which OAuth 1.0a treats as
// reserved. Pad those manually.
function rfc3986Encode(s: string): string {
  return encodeURIComponent(s).replace(/[!'()*]/g, (c) =>
    `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

// Build the OAuth 1.0a Authorization header for a request.
//
// `bodyParams` are the application/x-www-form-urlencoded body fields
// (NOT for JSON-body requests — pass {} when the body is JSON).
function buildAuthHeader(args: {
  method: string;
  url: string;
  bodyParams: Record<string, string>;
  creds: XCredentials;
}): string {
  const oauthParams: Record<string, string> = {
    oauth_consumer_key: args.creds.apiKey,
    oauth_token: args.creds.accessToken,
    oauth_signature_method: "HMAC-SHA1",
    oauth_timestamp: Math.floor(Date.now() / 1000).toString(),
    oauth_nonce: randomBytes(16).toString("hex"),
    oauth_version: "1.0",
  };

  // The parameter string for the signature base mixes oauth_* params
  // with body params (form-encoded only). For JSON bodies, body params
  // is empty.
  const allParams = { ...oauthParams, ...args.bodyParams };
  const paramString = Object.keys(allParams)
    .sort()
    .map((k) => `${rfc3986Encode(k)}=${rfc3986Encode(allParams[k]!)}`)
    .join("&");

  const baseString = [
    args.method.toUpperCase(),
    rfc3986Encode(args.url),
    rfc3986Encode(paramString),
  ].join("&");

  const signingKey =
    rfc3986Encode(args.creds.apiSecret) +
    "&" +
    rfc3986Encode(args.creds.accessTokenSecret);

  const signature = createHmac("sha1", signingKey)
    .update(baseString)
    .digest("base64");

  const headerParams: Record<string, string> = {
    ...oauthParams,
    oauth_signature: signature,
  };
  const headerString = Object.keys(headerParams)
    .sort()
    .map((k) => `${rfc3986Encode(k)}="${rfc3986Encode(headerParams[k]!)}"`)
    .join(", ");

  return `OAuth ${headerString}`;
}

async function postTweet(
  creds: XCredentials,
  text: string,
): Promise<ToolInvokeResult> {
  const authHeader = buildAuthHeader({
    method: "POST",
    url: X_TWEET_URL,
    bodyParams: {},
    creds,
  });

  let res: Response;
  try {
    res = await fetch(X_TWEET_URL, {
      method: "POST",
      headers: {
        Authorization: authHeader,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ text }),
    });
  } catch (err) {
    return {
      ok: false,
      errorCode: "network_error",
      errorMessage:
        err instanceof Error ? err.message : "fetch to X API failed",
    };
  }

  if (res.status === 429) {
    return {
      ok: false,
      errorCode: "rate_limited",
      errorMessage:
        "X rate limit exceeded. Free tier allows 17 posts/day per app.",
      rateLimited: true,
    };
  }

  const bodyText = await res.text();
  let body: unknown = null;
  try {
    body = JSON.parse(bodyText);
  } catch {
    // Non-JSON response (e.g., HTML error page from an upstream).
  }

  if (!res.ok) {
    const errBody = body as
      | { title?: string; detail?: string; errors?: { message?: string }[] }
      | null;
    const message =
      errBody?.detail ??
      errBody?.errors?.[0]?.message ??
      errBody?.title ??
      `X API returned ${res.status}`;
    return {
      ok: false,
      errorCode: `x_api_${res.status}`,
      errorMessage: message,
    };
  }

  const successBody = body as {
    data?: { id?: string; text?: string };
  } | null;

  const tweetId = successBody?.data?.id;
  if (!tweetId) {
    return {
      ok: false,
      errorCode: "x_api_unexpected_response",
      errorMessage: "X API succeeded but did not return a tweet id.",
    };
  }

  // X doesn't return a URL in the response, so we synthesize the
  // canonical one. The account handle is not in the API response either;
  // the URL with numeric id /status/<id> resolves regardless.
  const url = `https://x.com/i/web/status/${tweetId}`;

  return {
    ok: true,
    output: { tweetId, url },
    resultSummary: { tweetId, url },
  };
}

export const xHandler: ToolHandler = {
  type: "x",
  displayName: "X (Twitter)",
  description:
    "Post tweets from a configured X account. Uses OAuth 1.0a User Context, so posts are made as the X user who authorized the access token.",
  credentialsSchema,
  credentialFields: [
    {
      name: "apiKey",
      type: "string",
      required: true,
      secret: false,
      description: "Consumer key (a.k.a. API Key) from the X developer app.",
    },
    {
      name: "apiSecret",
      type: "string",
      required: true,
      secret: true,
      description: "Consumer secret. Shown once at app creation.",
    },
    {
      name: "accessToken",
      type: "string",
      required: true,
      secret: false,
      description: "OAuth 1.0a Access Token for the bot's X account.",
    },
    {
      name: "accessTokenSecret",
      type: "string",
      required: true,
      secret: true,
      description: "OAuth 1.0a Access Token Secret. Shown once at generation.",
    },
  ],
  actions: {
    tweet: {
      name: "tweet",
      description:
        "Post a single tweet. Standard length is 280 characters; longer posts (up to 25,000) require the account to have X Premium.",
      inputSchema: tweetInputSchema,
      outputSchema: tweetOutputSchema,
      invoke: async (ctx, input) => {
        const parsed = tweetInputSchema.safeParse(input);
        if (!parsed.success) {
          return {
            ok: false,
            errorCode: "invalid_input",
            errorMessage: parsed.error.message,
          };
        }
        const creds = ctx.credentials as XCredentials;
        return postTweet(creds, parsed.data.text);
      },
    },
  },
  testConnection: async ({ credentials }) => {
    const parsed = credentialsSchema.safeParse(credentials);
    if (!parsed.success) {
      return {
        ok: false,
        errorCode: "invalid_credentials_shape",
        errorMessage: parsed.error.message,
      };
    }
    // GET /2/users/me is the canonical "is this token alive?" probe.
    const url = "https://api.twitter.com/2/users/me";
    const authHeader = buildAuthHeader({
      method: "GET",
      url,
      bodyParams: {},
      creds: parsed.data,
    });
    try {
      const res = await fetch(url, { headers: { Authorization: authHeader } });
      if (res.ok) {
        const body = (await res.json()) as { data?: { username?: string } };
        return {
          ok: true,
          detail: body.data?.username
            ? `Connected as @${body.data.username}`
            : "Connected",
        };
      }
      const bodyText = await res.text();
      return {
        ok: false,
        errorCode: `x_api_${res.status}`,
        errorMessage: bodyText.slice(0, 200),
      };
    } catch (err) {
      return {
        ok: false,
        errorCode: "network_error",
        errorMessage:
          err instanceof Error ? err.message : "fetch to X API failed",
      };
    }
  },
};
