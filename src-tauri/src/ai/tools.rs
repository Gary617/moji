use serde::{Deserialize, Serialize};
use serde_json::Value;

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
        .filter_map(|tool| match (permission, tool.class) {
            (_, ToolClass::ReadOnly)
            | (AiPermission::Suggest, ToolClass::Suggestion)
            | (AiPermission::Assist, ToolClass::Suggestion) => Some(tool.name),
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
    }
}
