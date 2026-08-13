/* SPDX-License-Identifier: AGPL-3.0-or-later */

import { Type } from "typebox";

export const TORRENT_TOOL_NAMES = [
  "torrent_list",
  "torrent_details",
  "torrent_control",
  "torrent_providers",
  "torrent_search",
  "torrent_prepare",
  "torrent_draft",
  "torrent_commit",
  "torrent_cancel",
] as const;
export const TORRENT_WORKFLOW_ENTRY = "wildbuzzard-torrent-workflow";

const TORRENT_INTENT =
  /(?:\b(?:torrent|bittorrent|magnet|seeders?|leechers?|peer-to-peer)\b|\.torrent\b)/i;
const OPAQUE_ID = "^[A-Za-z0-9_-]{32}$";
const TORRENT_ID = "^[0-9A-Fa-f]{40}$";

const opaqueId = (description: string) =>
  Type.String({
    minLength: 32,
    maxLength: 32,
    pattern: OPAQUE_ID,
    description,
  });
const providerIds = Type.Array(Type.String({ minLength: 1, maxLength: 128 }), {
  minItems: 1,
  maxItems: 100,
  uniqueItems: true,
});

export const TorrentProviderParameters = Type.Object(
  {},
  { additionalProperties: false }
);

export const TorrentListParameters = Type.Object(
  {
    filter: Type.Optional(
      Type.Union(
        [
          "all",
          "downloading",
          "seeding",
          "completed",
          "stopped",
          "running",
          "active",
          "inactive",
          "stalled",
          "stalled_uploading",
          "stalled_downloading",
          "errored",
        ].map(value => Type.Literal(value))
      )
    ),
    category: Type.Optional(Type.String({ minLength: 1, maxLength: 256 })),
    tag: Type.Optional(Type.String({ minLength: 1, maxLength: 256 })),
    sort: Type.Optional(
      Type.Union(
        [
          "name",
          "size",
          "progress",
          "dlspeed",
          "upspeed",
          "priority",
          "num_seeds",
          "num_leechs",
          "eta",
          "ratio",
          "added_on",
          "completion_on",
        ].map(value => Type.Literal(value))
      )
    ),
    reverse: Type.Optional(Type.Boolean()),
    limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })),
    offset: Type.Optional(Type.Integer({ minimum: 0, maximum: 100_000 })),
  },
  { additionalProperties: false }
);

export const TorrentDetailsParameters = Type.Object(
  {
    id: Type.String({ pattern: TORRENT_ID }),
    section: Type.Optional(
      Type.Union([
        Type.Literal("overview"),
        Type.Literal("files"),
        Type.Literal("trackers"),
        Type.Literal("peers"),
      ])
    ),
    limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 500 })),
    offset: Type.Optional(Type.Integer({ minimum: 0, maximum: 100_000 })),
  },
  { additionalProperties: false }
);

export const TorrentControlParameters = Type.Object(
  {
    ids: Type.Array(Type.String({ pattern: TORRENT_ID }), {
      minItems: 1,
      maxItems: 100,
      uniqueItems: true,
    }),
    action: Type.Union([
      Type.Literal("start"),
      Type.Literal("stop"),
      Type.Literal("forceStart"),
      Type.Literal("autoStart"),
      Type.Literal("reannounce"),
      Type.Literal("recheck"),
      Type.Literal("delete"),
      Type.Literal("filePriority"),
      Type.Literal("limits"),
      Type.Literal("rename"),
      Type.Literal("sequential"),
      Type.Literal("firstLastPiece"),
    ]),
    confirmed: Type.Optional(Type.Boolean()),
    deleteData: Type.Optional(Type.Boolean()),
    fileIds: Type.Optional(
      Type.Array(Type.Integer({ minimum: 0 }), {
        minItems: 1,
        maxItems: 10_000,
        uniqueItems: true,
      })
    ),
    priority: Type.Optional(
      Type.Union([
        Type.Literal(0),
        Type.Literal(1),
        Type.Literal(6),
        Type.Literal(7),
      ])
    ),
    downloadLimit: Type.Optional(
      Type.Integer({ minimum: 0, maximum: 2_147_483_647 })
    ),
    uploadLimit: Type.Optional(
      Type.Integer({ minimum: 0, maximum: 2_147_483_647 })
    ),
    name: Type.Optional(Type.String({ minLength: 1, maxLength: 512 })),
    enabled: Type.Optional(Type.Boolean()),
  },
  { additionalProperties: false }
);

export const TorrentSearchParameters = Type.Object(
  {
    query: Type.String({ minLength: 1, maxLength: 256 }),
    providers: Type.Optional(providerIds),
    sort: Type.Optional(
      Type.Union([
        Type.Literal("seeders"),
        Type.Literal("leechers"),
        Type.Literal("size"),
        Type.Literal("published"),
        Type.Literal("name"),
      ])
    ),
    direction: Type.Optional(
      Type.Union([Type.Literal("asc"), Type.Literal("desc")])
    ),
    limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })),
    timeoutMs: Type.Optional(Type.Integer({ minimum: 1_000, maximum: 30_000 })),
  },
  { additionalProperties: false }
);

export const TorrentPrepareParameters = Type.Object(
  {
    searchId: opaqueId("Opaque search handle returned by torrent_search."),
    resultId: opaqueId("Opaque result handle from that search."),
  },
  { additionalProperties: false }
);

export const TorrentDraftParameters = Type.Object(
  {
    draftId: opaqueId("Opaque draft handle returned by torrent_prepare."),
  },
  { additionalProperties: false }
);

export const TorrentCommitParameters = Type.Object(
  {
    draftId: opaqueId("Opaque draft handle returned by torrent_prepare."),
    files: Type.Optional(
      Type.Array(Type.Integer({ minimum: 0 }), {
        minItems: 1,
        maxItems: 10_000,
        uniqueItems: true,
      })
    ),
    confirmed: Type.Boolean({
      description:
        "Must be true only after the user explicitly authorizes downloading this draft and file selection.",
    }),
  },
  { additionalProperties: false }
);

export function torrentToolsForPrompt(
  prompt: string,
  workflowActive = false
): string[] {
  return workflowActive || TORRENT_INTENT.test(prompt)
    ? [...TORRENT_TOOL_NAMES]
    : [];
}

export function restoreTorrentWorkflow(
  branch: Array<{ customType?: string; data?: unknown }>
): boolean {
  let active = false;
  for (const entry of branch) {
    if (entry.customType !== TORRENT_WORKFLOW_ENTRY) {
      continue;
    }
    active =
      typeof entry.data === "object" &&
      entry.data !== null &&
      (entry.data as { active?: unknown }).active === true;
  }
  return active;
}
