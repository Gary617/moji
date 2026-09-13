use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

const MAX_PROPOSAL_CHARS: usize = 200_000;

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub(crate) enum AiPermission {
    Suggest,
    Assist,
    Autonomous,
}

impl AiPermission {
    pub(crate) fn as_str(self) -> &'static str {
        match self {
            Self::Suggest => "suggest",
            Self::Assist => "assist",
            Self::Autonomous => "autonomous",
        }
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum ToolClass {
    ReadOnly,
    Suggestion,
    Write,
    Prohibited,
}

#[derive(Clone, Copy, Debug)]
pub(crate) struct ToolSpec {
    pub name: &'static str,
    pub class: ToolClass,
}

pub(crate) const TOOL_REGISTRY: &[ToolSpec] = &[
    ToolSpec { name: "get_active_goal", class: ToolClass::ReadOnly },
    ToolSpec { name: "list_project_tasks", class: ToolClass::ReadOnly },
    ToolSpec { name: "find_overdue_tasks", class: ToolClass::ReadOnly },
    ToolSpec { name: "find_schedule_conflicts", class: ToolClass::ReadOnly },
    ToolSpec { name: "search_workbench_memory", class: ToolClass::ReadOnly },
    ToolSpec { name: "get_recent_focus_and_checkins", class: ToolClass::ReadOnly },
    ToolSpec { name: "get_pending_proposals", class: ToolClass::ReadOnly },
    ToolSpec {
        name: "read_document_fragments",
        class: ToolClass::ReadOnly,
    },
    ToolSpec {
        name: "search_documents",
        class: ToolClass::ReadOnly,
    },
    ToolSpec {
        name: "propose_edit",
        class: ToolClass::Suggestion,
    },
    ToolSpec {
        name: "create_annotation",
        class: ToolClass::Suggestion,
    },
    ToolSpec {
        name: "create_task",
        class: ToolClass::Suggestion,
    },
    ToolSpec {
        name: "reschedule_task",
        class: ToolClass::Suggestion,
    },
    ToolSpec {
        name: "update_goal",
        class: ToolClass::Suggestion,
    },
    ToolSpec {
        name: "save_memory",
        class: ToolClass::Suggestion,
    },
    ToolSpec {
        name: "create_plan",
        class: ToolClass::Suggestion,
    },
    ToolSpec {
        name: "apply_document_edit",
        class: ToolClass::Write,
    },
    ToolSpec {
        name: "delete_document",
        class: ToolClass::Prohibited,
    },
    ToolSpec {
        name: "move_document",
        class: ToolClass::Prohibited,
    },
    ToolSpec {
        name: "system_command",
        class: ToolClass::Prohibited,
    },
    ToolSpec {
        name: "read_unselected_path",
        class: ToolClass::Prohibited,
    },
    ToolSpec {
        name: "set_api_key",
        class: ToolClass::Prohibited,
    },
];

pub(crate) fn tool_spec(name: &str) -> Option<ToolSpec> {
    TOOL_REGISTRY.iter().copied().find(|tool| tool.name == name)
}

pub(crate) fn allowed_tools(permission: AiPermission) -> Vec<&'static str> {
    TOOL_REGISTRY
        .iter()
        // Search can discover documents the user did not explicitly authorize for this chat.
        // Context selection is the only discovery boundary for the AI assistant.
        .filter(|tool| tool.name != "search_documents")
        .filter_map(|tool| match (permission, tool.class) {
            (_, ToolClass::ReadOnly) => Some(tool.name),
            (AiPermission::Assist | AiPermission::Autonomous, ToolClass::Suggestion) => {
                Some(tool.name)
            }
            (AiPermission::Autonomous, ToolClass::Write) => Some(tool.name),
            _ => None,
        })
        .collect()
}

pub(crate) fn tool_allowed(permission: AiPermission, name: &str) -> bool {
    let Some(spec) = tool_spec(name) else {
        return false;
    };
    allowed_tools(permission).contains(&spec.name)
}

pub(crate) fn target_document(arguments: &Value) -> Option<&str> {
    arguments
        .get("documentId")
        .and_then(Value::as_str)
        .or_else(|| arguments.get("document_id").and_then(Value::as_str))
}

pub(crate) fn tool_schema(name: &str) -> Option<Value> {
    let document_id = json!({ "type": "string", "minLength": 1, "maxLength": 128 });
    let page = json!({ "anyOf": [{ "type": "integer", "minimum": 1 }, { "type": "null" }] });
    match name {
        "get_active_goal" | "find_overdue_tasks" | "find_schedule_conflicts" | "get_recent_focus_and_checkins" | "get_pending_proposals" => Some(json!({"type":"object","additionalProperties":false,"properties":{}})),
        "list_project_tasks" => Some(json!({"type":"object","additionalProperties":false,"properties":{"projectId":{"type":"string","minLength":1,"maxLength":128}},"required":["projectId"]})),
        "search_workbench_memory" => Some(json!({"type":"object","additionalProperties":false,"properties":{"query":{"type":"string","maxLength":200}},"required":["query"]})),
        "read_document_fragments" => Some(json!({
            "type": "object",
            "additionalProperties": false,
            "properties": { "documentId": document_id, "page": page },
            "required": ["documentId", "page"]
        })),
        "propose_edit" | "apply_document_edit" => Some(json!({
            "type": "object",
            "additionalProperties": false,
            "properties": {
                "documentId": document_id,
                "content": { "type": "string", "maxLength": MAX_PROPOSAL_CHARS },
                "original": { "type": "string", "minLength": 1, "maxLength": MAX_PROPOSAL_CHARS }
            },
            "required": ["documentId", "content"]
        })),
        "create_annotation" => Some(json!({
            "type": "object",
            "additionalProperties": false,
            "properties": {
                "documentId": document_id,
                "body": { "type": "string", "minLength": 1, "maxLength": 4000 }
            },
            "required": ["documentId", "body"]
        })),
        "create_task" => Some(json!({
            "type":"object","additionalProperties":false,
            "properties":{"title":{"type":"string","minLength":1,"maxLength":240},"scheduledFor":{"type":"string","pattern":"^\\d{4}-\\d{2}-\\d{2}$"},"projectId":{"type":"string","maxLength":128},"estimateMinutes":{"type":"integer","minimum":1,"maximum":1440}},
            "required":["title","scheduledFor"]
        })),
        "reschedule_task" => Some(json!({
            "type":"object","additionalProperties":false,
            "properties":{"taskId":{"type":"string","minLength":1,"maxLength":128},"scheduledFor":{"type":"string","pattern":"^\\d{4}-\\d{2}-\\d{2}$"}},
            "required":["taskId","scheduledFor"]
        })),
        "update_goal" => Some(json!({
            "type":"object","additionalProperties":false,
            "properties":{"goalId":{"type":"string","minLength":1,"maxLength":128},"patch":{"type":"object","additionalProperties":true}},
            "required":["goalId","patch"]
        })),
        "save_memory" => Some(json!({
            "type":"object","additionalProperties":false,
            "properties":{"category":{"type":"string","minLength":1,"maxLength":64},"key":{"type":"string","minLength":1,"maxLength":128},"value":{"type":"string","minLength":1,"maxLength":2000},"goalId":{"type":["string","null"],"maxLength":128}},
            "required":["category","key","value"]
        })),
        "create_plan" => Some(json!({
            "type":"object","additionalProperties":false,
            "properties":{"title":{"type":"string","minLength":1,"maxLength":240},"steps":{"type":"array","minItems":1,"maxItems":50,"items":{"type":"string","minLength":1,"maxLength":500}}},
            "required":["title","steps"]
        })),
        _ => None,
    }
}

pub(crate) fn valid_tool_arguments(name: &str, arguments: &Value) -> bool {
    let Some(object) = arguments.as_object() else {
        return false;
    };
    let valid_document_id = object
        .get("documentId")
        .and_then(Value::as_str)
        .is_some_and(|value| !value.is_empty() && value.len() <= 128);
    match name {
        "get_active_goal" | "find_overdue_tasks" | "find_schedule_conflicts" | "get_recent_focus_and_checkins" | "get_pending_proposals" => object.is_empty(),
        "list_project_tasks" => object.len() == 1 && object.get("projectId").and_then(Value::as_str).is_some_and(|value| !value.is_empty() && value.len() <= 128),
        "search_workbench_memory" => object.len() == 1 && object.get("query").and_then(Value::as_str).is_some_and(|value| value.chars().count() <= 200),
        "read_document_fragments" => {
            valid_document_id
                && object.len() == 2
                && object.get("page").is_some_and(|page| {
                    page.is_null()
                        || page
                            .as_u64()
                            .is_some_and(|value| value > 0 && value <= u32::MAX as u64)
                })
        }
        "propose_edit" | "apply_document_edit" => {
            valid_document_id
                && (object.len() == 2 || object.len() == 3)
                && object
                    .get("content")
                    .and_then(Value::as_str)
                    .is_some_and(|content| content.chars().count() <= MAX_PROPOSAL_CHARS)
                && object
                    .get("original")
                    .map(|value| value.as_str().is_some_and(|content| !content.is_empty() && content.chars().count() <= MAX_PROPOSAL_CHARS))
                    .unwrap_or(true)
        }
        "create_annotation" => {
            valid_document_id
                && object.len() == 2
                && object
                    .get("body")
                    .and_then(Value::as_str)
                    .is_some_and(|body| !body.is_empty() && body.len() <= 4_000)
        }
        "create_task" => {
            object.len() >= 2 && object.len() <= 4
                && object.get("title").and_then(Value::as_str).is_some_and(|v| !v.trim().is_empty() && v.chars().count() <= 240)
                && object.get("scheduledFor").and_then(Value::as_str).is_some_and(|v| date_like(v))
                && object.get("projectId").map(|v| v.as_str().is_some_and(|s| s.chars().count() <= 128)).unwrap_or(true)
                && object.get("estimateMinutes").map(|v| v.as_u64().is_some_and(|n| (1..=1440).contains(&n))).unwrap_or(true)
        }
        "reschedule_task" => object.len() == 2
            && object.get("taskId").and_then(Value::as_str).is_some_and(|v| !v.is_empty() && v.chars().count() <= 128)
            && object.get("scheduledFor").and_then(Value::as_str).is_some_and(|v| date_like(v)),
        "update_goal" => object.len() == 2
            && object.get("goalId").and_then(Value::as_str).is_some_and(|v| !v.is_empty() && v.chars().count() <= 128)
            && object.get("patch").is_some_and(Value::is_object),
        "save_memory" => object.len() >= 3 && object.len() <= 4
            && object.get("category").and_then(Value::as_str).is_some_and(|v| !v.is_empty() && v.chars().count() <= 64)
            && object.get("key").and_then(Value::as_str).is_some_and(|v| !v.is_empty() && v.chars().count() <= 128)
            && object.get("value").and_then(Value::as_str).is_some_and(|v| !v.is_empty() && v.chars().count() <= 2000)
            && object.get("goalId").map(|v| v.is_null() || v.as_str().is_some_and(|s| s.chars().count() <= 128)).unwrap_or(true),
        "create_plan" => object.len() == 2
            && object.get("title").and_then(Value::as_str).is_some_and(|v| !v.trim().is_empty() && v.chars().count() <= 240)
            && object.get("steps").and_then(Value::as_array).is_some_and(|items| !items.is_empty() && items.len() <= 50 && items.iter().all(|v| v.as_str().is_some_and(|s| !s.trim().is_empty() && s.chars().count() <= 500))),
        _ => false,
    }
}

fn date_like(value: &str) -> bool {
    value.len() == 10 && value.as_bytes().get(4) == Some(&b'-') && value.as_bytes().get(7) == Some(&b'-')
        && value.bytes().enumerate().all(|(i, b)| i == 4 || i == 7 || b.is_ascii_digit())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn permission_whitelist_keeps_prohibited_tools_out() {
        assert!(tool_allowed(
            AiPermission::Suggest,
            "read_document_fragments"
        ));
        assert!(tool_allowed(AiPermission::Assist, "propose_edit"));
        assert!(!tool_allowed(AiPermission::Assist, "apply_document_edit"));
        assert!(tool_allowed(
            AiPermission::Autonomous,
            "apply_document_edit"
        ));
        assert!(!tool_allowed(AiPermission::Autonomous, "system_command"));
        assert!(!tool_allowed(AiPermission::Autonomous, "set_api_key"));
        let schema = tool_schema("propose_edit").unwrap();
        assert_eq!(schema["additionalProperties"], false);
        assert!(tool_schema("system_command").is_none());
        assert!(valid_tool_arguments(
            "read_document_fragments",
            &json!({ "documentId": "doc-1", "page": null })
        ));
        assert!(!tool_allowed(AiPermission::Suggest, "propose_edit"));
        assert!(!allowed_tools(AiPermission::Suggest).contains(&"apply_document_edit"));
        assert!(!valid_tool_arguments(
            "read_document_fragments",
            &json!({ "documentId": "doc-1", "page": 1, "path": "C:/untrusted" })
        ));
        assert!(tool_allowed(AiPermission::Assist, "create_task"));
        assert!(!tool_allowed(AiPermission::Suggest, "create_task"));
        assert!(valid_tool_arguments("create_task", &json!({"title":"复习","scheduledFor":"2026-09-13"})));
        assert!(!valid_tool_arguments("create_task", &json!({"title":"复习","scheduledFor":"tomorrow"})));
        assert!(valid_tool_arguments("save_memory", &json!({"category":"preference","key":"time","value":"晚上"})));
    }
}
