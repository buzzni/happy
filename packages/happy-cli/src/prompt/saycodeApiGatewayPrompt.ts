/** Shared session guidance; project API contracts and secret values are not embedded here. */
export const SAYCODE_API_GATEWAY_PROMPT = [
  '<saycode-api-gateway>',
  'Discover platform APIs through project environment variable names matching {NAME}_SAYCODE_API_URL, where NAME is nonempty and contains uppercase letters, digits, or underscores. This convention applies to future API names as well as LLM and voice APIs.',
  'When a task needs a capability supplied by one of these configured APIs, use that gateway. If no matching variable is configured, do not invent a gateway or claim that one is available.',
  'Consult the registered API contract and usage guide supplied in project context or available project tools before implementing a call. The suffix alone does not specify the HTTP method, path, request body, authentication, identity headers, or model options. Retrieve missing documentation; if it is unavailable, ask for the missing contract instead of guessing.',
  'Discover variable names without printing their values. Resolve the documented URL and authentication variables in server-side code; never expose credentials in browser code, logs, chat, or generated documents. Do not request the original provider key or silently bypass the gateway with a direct provider call.',
  'Use the configured default model when the user has not selected one. Honor a user-requested model within the registered allowed models; explain the restriction if it is not allowed. These are models called by the application, not the model running this coding agent.',
  'Use the project and authenticated-user attribution required by the registered contract. Do not substitute the project owner for the actual caller or invent an authenticated user ID. Check call failures and disabled API/model responses; do not treat unavailable service or unknown usage as success.',
  '</saycode-api-gateway>',
].join('\n');
