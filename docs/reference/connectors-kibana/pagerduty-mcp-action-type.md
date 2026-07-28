---
navigation_title: "PagerDuty (MCP)"
type: reference
description: "Use the PagerDuty data source to access incidents, escalation policies, schedules, on-calls, users, and teams using the PagerDuty MCP server."
applies_to:
  stack: preview 9.4
  serverless: preview
---

# PagerDuty (MCP) connector [pagerduty-mcp-action-type]

The PagerDuty data source connects to PagerDuty through the PagerDuty MCP server to access incidents, escalation policies, schedules, on-calls, users, and teams. Use it in data and context sources and agentic workflows to search and retrieve PagerDuty data. It authenticates with a PagerDuty REST API token.

## Create connectors in {{kib}} [define-pagerduty-mcp-ui]

You add and configure the PagerDuty data source when setting up a data or context source in {{kib}}.

### Connector configuration [pagerduty-mcp-connector-configuration]

PagerDuty (MCP) connectors have the following configuration properties:

API Key
:   A PagerDuty REST API token, entered in the form `Token token=YOUR_API_KEY`. Refer to [Get credentials](#pagerduty-mcp-credentials) for instructions.

## Test connectors [pagerduty-mcp-action-configuration]

You can test connectors when you create or edit the connector in {{kib}}. The test verifies connectivity by listing the tools available on the PagerDuty MCP server.

## Connector actions [pagerduty-mcp-connector-actions]

The PagerDuty (MCP) connector has the following actions:

### Incidents

`listIncidents`
:   List PagerDuty incidents. Supports filtering by status (`triggered`, `acknowledged`, or `resolved`), service IDs, user IDs, urgency, and date range, and sorting by incident number, creation time, resolution time, or urgency.

`getIncident`
:   Get a specific incident by its ID. Returns the incident's summary, status, urgency, service, current assignments, and creation and update timestamps.

### On-call coverage

`listSchedules`
:   List on-call schedules. Supports free-text search across name and description fields and filtering by team or user IDs.

`getSchedule`
:   Get a specific on-call schedule by its ID. Returns the schedule's name, description, time zone, schedule layers, and the users on the schedule.

`listOncalls`
:   Get current on-call assignments. Supports filtering by schedule IDs, user IDs, or escalation policy IDs, and by time range.

`listEscalationPolicies`
:   List escalation policies. Supports free-text search across name and description fields and filtering by user or team IDs.

`getEscalationPolicy`
:   Get a specific escalation policy by its ID. Returns the policy's escalation rules, associated services, and teams.

### Users and teams

`getUserData`
:   Retrieve the PagerDuty user that owns the API key, including ID, name, email, role, and team memberships. Use this to confirm which account the connector is authenticated as.

`listUsers`
:   List PagerDuty users. Supports free-text search across name and email fields.

`listTeams`
:   List PagerDuty teams. Supports free-text search across name and description fields.

`getTeam`
:   Get a specific team by its ID. Returns the team's ID, name, description, and summary.

### Utilities

`listTools`
:   List all tools available on the PagerDuty MCP server. Use this to discover capabilities that are not exposed as named actions.

`callTool`
:   Call any tool on the PagerDuty MCP server directly by name. Use this as a fallback for tools that are not yet exposed as named actions. Use `listTools` first to discover available tool names and their arguments.

## Connector networking configuration [pagerduty-mcp-connector-networking-configuration]

Use the [Action configuration settings](/reference/configuration-reference/alerting-settings.md#action-settings) to customize connector networking configurations, such as proxies, certificates, or TLS settings. You can set configurations that apply to all your connectors or use `xpack.actions.customHostSettings` to set per-host configurations.

## Get credentials [pagerduty-mcp-credentials]

To use the PagerDuty data source, you need a PagerDuty **API token** (REST API). This is not the same as an integration key used for the alerting connector.

1. Log in to [PagerDuty](https://www.pagerduty.com/).
2. Go to **Integrations** > **Developer Tools** > **API Access Keys** (or **User Settings** > **API Access** in some layouts).
3. Select **Create API User Token** (user token) or **Create Key** (general access key; requires admin). User tokens are scoped to your permissions.
4. Enter a description (for example, `Kibana data source`) and create the token.
5. Copy the token and store it securely. You cannot see it again after this point. Enter this value as the **API token** when configuring the PagerDuty data source in {{kib}}.

For more details, refer to [PagerDuty API access keys](https://support.pagerduty.com/docs/api-access-keys) and [API authentication](https://developer.pagerduty.com/docs/rest-api-v2/authentication/).
