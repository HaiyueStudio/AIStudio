// Reviewed native schemas from chrome-devtools-mcp 1.9.0; checked again before execution.
import type { JsonObject } from "@haiyue/ai-studio-contracts";
export const DEVTOOLS_CATALOG: readonly { name: string; description: string; parameters: JsonObject; output: JsonObject }[] = [
  {
    "name": "mcp__chrome-devtools-mcp__click",
    "description": "Clicks on the provided element",
    "parameters": {
      "type": "object",
      "properties": {
        "pageId": {
          "type": "number",
          "description": "Targets a specific page by ID."
        },
        "uid": {
          "type": "string",
          "description": "The uid of an element on the page from the page content snapshot"
        },
        "dblClick": {
          "type": "boolean",
          "description": "Set to true for double clicks. Default is false."
        },
        "includeSnapshot": {
          "type": "boolean",
          "description": "Whether to include a snapshot in the response. Default is false."
        }
      },
      "required": [
        "pageId",
        "uid"
      ],
      "additionalProperties": true,
      "$schema": "http://json-schema.org/draft-07/schema#"
    },
    "output": {
      "type": "object",
      "properties": {
        "content": {
          "type": "array",
          "items": {}
        },
        "structuredContent": {}
      },
      "required": [
        "content"
      ],
      "additionalProperties": false
    }
  },
  {
    "name": "mcp__chrome-devtools-mcp__close_page",
    "description": "Closes the page by its index. The last open page cannot be closed.",
    "parameters": {
      "type": "object",
      "properties": {
        "pageId": {
          "type": "number",
          "description": "The ID of the page to close. Call list_pages to list pages."
        }
      },
      "required": [
        "pageId"
      ],
      "additionalProperties": true,
      "$schema": "http://json-schema.org/draft-07/schema#"
    },
    "output": {
      "type": "object",
      "properties": {
        "content": {
          "type": "array",
          "items": {}
        },
        "structuredContent": {}
      },
      "required": [
        "content"
      ],
      "additionalProperties": false
    }
  },
  {
    "name": "mcp__chrome-devtools-mcp__fill",
    "description": "Type text into an input, text area or select an option from a <select> element.",
    "parameters": {
      "type": "object",
      "properties": {
        "pageId": {
          "type": "number",
          "description": "Targets a specific page by ID."
        },
        "uid": {
          "type": "string",
          "description": "The uid of an element on the page from the page content snapshot"
        },
        "value": {
          "type": "string",
          "description": "The value to fill in. \"true\" or \"false\" for checkboxes and toggles, \"true\" for radio buttons."
        },
        "includeSnapshot": {
          "type": "boolean",
          "description": "Whether to include a snapshot in the response. Default is false."
        }
      },
      "required": [
        "pageId",
        "uid",
        "value"
      ],
      "additionalProperties": true,
      "$schema": "http://json-schema.org/draft-07/schema#"
    },
    "output": {
      "type": "object",
      "properties": {
        "content": {
          "type": "array",
          "items": {}
        },
        "structuredContent": {}
      },
      "required": [
        "content"
      ],
      "additionalProperties": false
    }
  },
  {
    "name": "mcp__chrome-devtools-mcp__list_console_messages",
    "description": "List all console messages for the target page since the last navigation.",
    "parameters": {
      "type": "object",
      "properties": {
        "pageId": {
          "type": "number",
          "description": "Targets a specific page by ID."
        },
        "pageSize": {
          "type": "integer",
          "exclusiveMinimum": 0,
          "description": "Maximum number of messages to return. When omitted, returns all messages."
        },
        "pageIdx": {
          "type": "integer",
          "minimum": 0,
          "description": "Page number to return (0-based). When omitted, returns the first page."
        },
        "types": {
          "type": "array",
          "items": {
            "type": "string",
            "enum": [
              "log",
              "debug",
              "info",
              "error",
              "warn",
              "dir",
              "dirxml",
              "table",
              "trace",
              "clear",
              "startGroup",
              "startGroupCollapsed",
              "endGroup",
              "assert",
              "profile",
              "profileEnd",
              "count",
              "timeEnd",
              "verbose",
              "issue"
            ]
          },
          "description": "Filter messages to only return messages of the specified resource types. When omitted or empty, returns all messages."
        },
        "includePreservedMessages": {
          "type": "boolean",
          "default": false,
          "description": "Set to true to return the preserved messages over the last 3 navigations."
        },
        "includeStackTraces": {
          "type": "boolean",
          "default": false,
          "description": "Set to true to include the stack trace for each message when available. Increases the response size."
        },
        "serviceWorkerId": {
          "type": "string",
          "description": "Filter messages to only return messages of the specified service worker."
        }
      },
      "required": [
        "pageId"
      ],
      "additionalProperties": true,
      "$schema": "http://json-schema.org/draft-07/schema#"
    },
    "output": {
      "type": "object",
      "properties": {
        "content": {
          "type": "array",
          "items": {}
        },
        "structuredContent": {}
      },
      "required": [
        "content"
      ],
      "additionalProperties": false
    }
  },
  {
    "name": "mcp__chrome-devtools-mcp__list_network_requests",
    "description": "Lists the most recent requests for the target page since the last navigation.",
    "parameters": {
      "type": "object",
      "properties": {
        "pageId": {
          "type": "number",
          "description": "Targets a specific page by ID."
        },
        "pageSize": {
          "type": "integer",
          "exclusiveMinimum": 0,
          "description": "Maximum number of requests to return. When omitted, returns all requests."
        },
        "pageIdx": {
          "type": "integer",
          "minimum": 0,
          "description": "Page number to return (0-based). When omitted, returns the first page."
        },
        "resourceTypes": {
          "type": "array",
          "items": {
            "type": "string",
            "enum": [
              "document",
              "stylesheet",
              "image",
              "media",
              "font",
              "script",
              "texttrack",
              "xhr",
              "fetch",
              "prefetch",
              "eventsource",
              "websocket",
              "manifest",
              "signedexchange",
              "ping",
              "cspviolationreport",
              "preflight",
              "fedcm",
              "other"
            ]
          },
          "description": "Filter requests to only return requests of the specified resource types. When omitted or empty, returns all requests."
        },
        "includePreservedRequests": {
          "type": "boolean",
          "default": false,
          "description": "Set to true to return the preserved requests over the last 3 navigations."
        }
      },
      "required": [
        "pageId"
      ],
      "additionalProperties": true,
      "$schema": "http://json-schema.org/draft-07/schema#"
    },
    "output": {
      "type": "object",
      "properties": {
        "content": {
          "type": "array",
          "items": {}
        },
        "structuredContent": {}
      },
      "required": [
        "content"
      ],
      "additionalProperties": false
    }
  },
  {
    "name": "mcp__chrome-devtools-mcp__list_pages",
    "description": "Get a list of pages open in the browser.",
    "parameters": {
      "type": "object",
      "properties": {},
      "additionalProperties": true,
      "$schema": "http://json-schema.org/draft-07/schema#"
    },
    "output": {
      "type": "object",
      "properties": {
        "content": {
          "type": "array",
          "items": {}
        },
        "structuredContent": {}
      },
      "required": [
        "content"
      ],
      "additionalProperties": false
    }
  },
  {
    "name": "mcp__chrome-devtools-mcp__navigate_page",
    "description": "Go to a URL, or back, forward, or reload. Use project URL if not specified otherwise.",
    "parameters": {
      "type": "object",
      "properties": {
        "pageId": {
          "type": "number",
          "description": "Targets a specific page by ID."
        },
        "type": {
          "type": "string",
          "enum": [
            "url",
            "back",
            "forward",
            "reload"
          ],
          "description": "Navigate the page by URL, back or forward in history, or reload."
        },
        "url": {
          "type": "string",
          "description": "Target URL (only type=url)"
        },
        "ignoreCache": {
          "type": "boolean",
          "description": "Whether to ignore cache on reload."
        },
        "handleBeforeUnload": {
          "type": "string",
          "enum": [
            "accept",
            "dismiss"
          ],
          "description": "Whether to auto accept or beforeunload dialogs triggered by this navigation. Default is accept."
        },
        "initScript": {
          "type": "string",
          "description": "A JavaScript script to be executed on each new document before any other scripts for the next navigation."
        },
        "timeout": {
          "type": "integer",
          "description": "Maximum wait time in milliseconds. If set to 0, the default timeout will be used."
        }
      },
      "required": [
        "pageId"
      ],
      "additionalProperties": true,
      "$schema": "http://json-schema.org/draft-07/schema#"
    },
    "output": {
      "type": "object",
      "properties": {
        "content": {
          "type": "array",
          "items": {}
        },
        "structuredContent": {}
      },
      "required": [
        "content"
      ],
      "additionalProperties": false
    }
  },
  {
    "name": "mcp__chrome-devtools-mcp__new_page",
    "description": "Open a new tab and load a URL. Use project URL if not specified otherwise.",
    "parameters": {
      "type": "object",
      "properties": {
        "url": {
          "type": "string",
          "description": "URL to load in a new page."
        },
        "background": {
          "type": "boolean",
          "description": "Whether to open the page in the background without bringing it to the front. Default is false (foreground)."
        },
        "isolatedContext": {
          "type": "string",
          "description": "If specified, the page is created in an isolated browser context with the given name. Pages in the same browser context share cookies and storage. Pages in different browser contexts are fully isolated (useful for clean-slate testing of cookies and authentication)."
        },
        "timeout": {
          "type": "integer",
          "description": "Maximum wait time in milliseconds. If set to 0, the default timeout will be used."
        }
      },
      "required": [
        "url"
      ],
      "additionalProperties": true,
      "$schema": "http://json-schema.org/draft-07/schema#"
    },
    "output": {
      "type": "object",
      "properties": {
        "content": {
          "type": "array",
          "items": {}
        },
        "structuredContent": {}
      },
      "required": [
        "content"
      ],
      "additionalProperties": false
    }
  },
  {
    "name": "mcp__chrome-devtools-mcp__press_key",
    "description": "Press a key or key combination. Use this when other input methods like fill() cannot be used (e.g., keyboard shortcuts, navigation keys, or special key combinations).",
    "parameters": {
      "type": "object",
      "properties": {
        "pageId": {
          "type": "number",
          "description": "Targets a specific page by ID."
        },
        "key": {
          "type": "string",
          "description": "A key or a combination (e.g., \"Enter\", \"Control+A\", \"Control++\", \"Control+Shift+R\"). Modifiers: Control, Shift, Alt, Meta"
        },
        "includeSnapshot": {
          "type": "boolean",
          "description": "Whether to include a snapshot in the response. Default is false."
        }
      },
      "required": [
        "pageId",
        "key"
      ],
      "additionalProperties": true,
      "$schema": "http://json-schema.org/draft-07/schema#"
    },
    "output": {
      "type": "object",
      "properties": {
        "content": {
          "type": "array",
          "items": {}
        },
        "structuredContent": {}
      },
      "required": [
        "content"
      ],
      "additionalProperties": false
    }
  },
  {
    "name": "mcp__chrome-devtools-mcp__take_snapshot",
    "description": "Take a text snapshot of the target page based on the a11y tree. The snapshot lists page elements along with a unique\nidentifier (uid). Always use the latest snapshot. Prefer taking a snapshot over taking a screenshot. The snapshot indicates the element selected\nin the DevTools Elements panel (if any).",
    "parameters": {
      "type": "object",
      "properties": {
        "pageId": {
          "type": "number",
          "description": "Targets a specific page by ID."
        },
        "verbose": {
          "type": "boolean",
          "description": "Whether to include all possible information available in the full a11y tree. Default is false."
        },
        "filePath": {
          "type": "string",
          "description": "The absolute path, or a path relative to the current working directory, to save the snapshot to instead of attaching it to the response."
        }
      },
      "required": [
        "pageId"
      ],
      "additionalProperties": true,
      "$schema": "http://json-schema.org/draft-07/schema#"
    },
    "output": {
      "type": "object",
      "properties": {
        "content": {
          "type": "array",
          "items": {}
        },
        "structuredContent": {}
      },
      "required": [
        "content"
      ],
      "additionalProperties": false
    }
  }
];
