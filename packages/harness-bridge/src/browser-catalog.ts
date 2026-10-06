// Reviewed schemas from @playwright/mcp 0.0.80 through dsh-mcp-client 0.2.0-rc.2.
// Unchanged native schemas are rechecked before every execution.
import type { JsonObject } from "@haiyue/ai-studio-contracts";
export const BROWSER_CATALOG: readonly { name: string; description: string; parameters: JsonObject; output: JsonObject }[] = [
  {
    "name": "mcp__playwright-mcp__browser_close",
    "description": "Close the page",
    "parameters": {
      "type": "object",
      "properties": {},
      "$schema": "https://json-schema.org/draft/2020-12/schema",
      "additionalProperties": false
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
    "name": "mcp__playwright-mcp__browser_resize",
    "description": "Resize the browser window",
    "parameters": {
      "type": "object",
      "properties": {
        "width": {
          "type": "number",
          "description": "Width of the browser window"
        },
        "height": {
          "type": "number",
          "description": "Height of the browser window"
        }
      },
      "required": [
        "width",
        "height"
      ],
      "$schema": "https://json-schema.org/draft/2020-12/schema",
      "additionalProperties": false
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
    "name": "mcp__playwright-mcp__browser_console_messages",
    "description": "Returns all console messages",
    "parameters": {
      "type": "object",
      "properties": {
        "level": {
          "default": "info",
          "description": "Level of the console messages to return. Each level includes the messages of more severe levels. Defaults to \"info\".",
          "type": "string",
          "enum": [
            "error",
            "warning",
            "info",
            "debug"
          ]
        },
        "all": {
          "description": "Return all console messages since the beginning of the session, not just since the last navigation. Defaults to false.",
          "type": "boolean"
        },
        "filename": {
          "description": "Filename to save the console messages to. If not provided, messages are returned as text.",
          "type": "string"
        }
      },
      "required": [
        "level"
      ],
      "$schema": "https://json-schema.org/draft/2020-12/schema",
      "additionalProperties": false
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
    "name": "mcp__playwright-mcp__browser_find",
    "description": "Search the accessibility snapshot of the current page for text or a regular expression. Returns matching snapshot nodes with a few lines of surrounding context (like search snippets), each shown under its path from the root of the tree, which is cheaper than capturing the whole snapshot when you only need to locate an element and its ref.",
    "parameters": {
      "type": "object",
      "properties": {
        "text": {
          "description": "Plain text to search for in the page snapshot (case-insensitive substring match). Provide either text or regex, not both.",
          "type": "string"
        },
        "regex": {
          "description": "Regular expression to search for in the page snapshot. Matching is case-sensitive by default; wrap the pattern in slashes to add flags, e.g. \"/error/i\" for case-insensitive. Provide either text or regex, not both.",
          "type": "string"
        }
      },
      "$schema": "https://json-schema.org/draft/2020-12/schema",
      "additionalProperties": false
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
    "name": "mcp__playwright-mcp__browser_press_key",
    "description": "Press a key on the keyboard",
    "parameters": {
      "type": "object",
      "properties": {
        "key": {
          "type": "string",
          "description": "Name of the key to press or a character to generate, such as `ArrowLeft` or `a`"
        }
      },
      "required": [
        "key"
      ],
      "$schema": "https://json-schema.org/draft/2020-12/schema",
      "additionalProperties": false
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
    "name": "mcp__playwright-mcp__browser_type",
    "description": "Type text into editable element",
    "parameters": {
      "type": "object",
      "properties": {
        "element": {
          "description": "Human-readable element description used to obtain permission to interact with the element",
          "type": "string"
        },
        "target": {
          "type": "string",
          "description": "Exact target element reference from the page snapshot, or a unique element selector"
        },
        "text": {
          "type": "string",
          "description": "Text to type into the element"
        },
        "submit": {
          "description": "Whether to submit entered text (press Enter after)",
          "type": "boolean"
        },
        "slowly": {
          "description": "Whether to type one character at a time. Useful for triggering key handlers in the page. By default entire text is filled in at once.",
          "type": "boolean"
        }
      },
      "required": [
        "target",
        "text"
      ],
      "$schema": "https://json-schema.org/draft/2020-12/schema",
      "additionalProperties": false
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
    "name": "mcp__playwright-mcp__browser_navigate",
    "description": "Navigate to a URL",
    "parameters": {
      "type": "object",
      "properties": {
        "url": {
          "type": "string",
          "description": "The URL to navigate to"
        }
      },
      "required": [
        "url"
      ],
      "$schema": "https://json-schema.org/draft/2020-12/schema",
      "additionalProperties": false
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
    "name": "mcp__playwright-mcp__browser_navigate_back",
    "description": "Go back to the previous page in the history",
    "parameters": {
      "type": "object",
      "properties": {},
      "$schema": "https://json-schema.org/draft/2020-12/schema",
      "additionalProperties": false
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
    "name": "mcp__playwright-mcp__browser_network_requests",
    "description": "Returns a numbered list of network requests since loading the page. Use browser_network_request with the number to get full details.",
    "parameters": {
      "type": "object",
      "properties": {
        "static": {
          "default": false,
          "description": "Whether to include successful static resources like images, fonts, scripts, etc. Defaults to false.",
          "type": "boolean"
        },
        "filter": {
          "description": "Only return requests whose URL matches this regexp (e.g. \"/api/.*user\").",
          "type": "string"
        },
        "filename": {
          "description": "Filename to save the network requests to. If not provided, requests are returned as text.",
          "type": "string"
        }
      },
      "required": [
        "static"
      ],
      "$schema": "https://json-schema.org/draft/2020-12/schema",
      "additionalProperties": false
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
    "name": "mcp__playwright-mcp__browser_snapshot",
    "description": "Capture accessibility snapshot of the current page, this is better than screenshot",
    "parameters": {
      "type": "object",
      "properties": {
        "target": {
          "description": "Exact target element reference from the page snapshot, or a unique element selector",
          "type": "string"
        },
        "filename": {
          "description": "Save snapshot to markdown file instead of returning it in the response.",
          "type": "string"
        },
        "depth": {
          "description": "Limit the depth of the snapshot tree",
          "type": "number"
        },
        "boxes": {
          "description": "Include each element's bounding box as [box=x,y,width,height] in the snapshot. Coordinates are viewport-relative, in CSS pixels (Element.getBoundingClientRect)",
          "type": "boolean"
        }
      },
      "$schema": "https://json-schema.org/draft/2020-12/schema",
      "additionalProperties": false
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
    "name": "mcp__playwright-mcp__browser_click",
    "description": "Perform click on a web page",
    "parameters": {
      "type": "object",
      "properties": {
        "element": {
          "description": "Human-readable element description used to obtain permission to interact with the element",
          "type": "string"
        },
        "target": {
          "type": "string",
          "description": "Exact target element reference from the page snapshot, or a unique element selector"
        },
        "doubleClick": {
          "description": "Whether to perform a double click instead of a single click",
          "type": "boolean"
        },
        "button": {
          "description": "Button to click, defaults to left",
          "type": "string",
          "enum": [
            "left",
            "right",
            "middle"
          ]
        },
        "modifiers": {
          "description": "Modifier keys to press",
          "type": "array",
          "items": {
            "type": "string",
            "enum": [
              "Alt",
              "Control",
              "ControlOrMeta",
              "Meta",
              "Shift"
            ]
          }
        }
      },
      "required": [
        "target"
      ],
      "$schema": "https://json-schema.org/draft/2020-12/schema",
      "additionalProperties": false
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
