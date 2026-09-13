use serde_json::{Value, json};

/// Read-only tools for the workbench Agent. They operate only on the bounded
/// snapshot supplied by the caller; no filesystem or network access is allowed.
pub(crate) fn run(name: &str, arguments: &Value, snapshot: &Value) -> Result<Value, String> {
    match name {
        "create_task" => {
            let title = arguments.get("title").and_then(Value::as_str).ok_or("缺少任务标题")?;
            let scheduled_for = arguments.get("scheduledFor").and_then(Value::as_str).ok_or("缺少任务日期")?;
            Ok(json!({ "proposal": { "type": "createTask", "task": { "title": title, "scheduledFor": scheduled_for, "projectId": arguments.get("projectId").cloned().unwrap_or(Value::Null), "estimateMinutes": arguments.get("estimateMinutes").cloned().unwrap_or(json!(30)) }}, "requiresConfirmation": true }))
        }
        "reschedule_task" => {
            let task_id = arguments.get("taskId").and_then(Value::as_str).ok_or("缺少任务 ID")?;
            let scheduled_for = arguments.get("scheduledFor").and_then(Value::as_str).ok_or("缺少任务日期")?;
            let tasks = snapshot.get("tasks").and_then(Value::as_array).ok_or("快照缺少任务")?;
            let task = tasks.iter().find(|task| task.get("id").and_then(Value::as_str) == Some(task_id)).ok_or("快照中找不到目标任务")?;
            Ok(json!({ "proposal": { "type": "rescheduleTask", "taskId": task_id, "before": task.get("scheduledFor").cloned().unwrap_or(Value::Null), "after": scheduled_for }, "requiresConfirmation": true }))
        }
        "update_goal" => {
            let goal_id = arguments.get("goalId").and_then(Value::as_str).ok_or("缺少目标 ID")?;
            let goals = snapshot.get("goals").and_then(Value::as_array).ok_or("快照缺少目标")?;
            let goal = goals.iter().find(|goal| goal.get("id").and_then(Value::as_str) == Some(goal_id)).ok_or("快照中找不到目标")?;
            Ok(json!({ "proposal": { "type": "updateGoal", "goalId": goal_id, "before": goal, "patch": arguments.get("patch").cloned().unwrap_or(json!({})) }, "requiresConfirmation": true }))
        }
        "save_memory" => {
            Ok(json!({ "proposal": { "type": "saveMemory", "memory": arguments }, "requiresConfirmation": true }))
        }
        "create_plan" => {
            Ok(json!({ "proposal": { "type": "createPlan", "plan": arguments }, "requiresConfirmation": true }))
        }
        "get_active_goal" => {
            let goals = snapshot.get("goals").and_then(Value::as_array).ok_or("快照缺少目标")?;
            Ok(json!({ "goals": goals.iter().take(5).collect::<Vec<_>>() }))
        }
        "list_project_tasks" => {
            let project_id = arguments.get("projectId").and_then(Value::as_str).ok_or("缺少 projectId")?;
            let tasks = snapshot.get("tasks").and_then(Value::as_array).ok_or("快照缺少任务")?;
            let items = tasks.iter().filter(|task| task.get("projectId").and_then(Value::as_str) == Some(project_id)).take(80).collect::<Vec<_>>();
            Ok(json!({ "projectId": project_id, "tasks": items }))
        }
        "find_overdue_tasks" => {
            let today = snapshot.get("currentDate").and_then(Value::as_str).ok_or("快照缺少当前日期")?;
            let tasks = snapshot.get("tasks").and_then(Value::as_array).ok_or("快照缺少任务")?;
            Ok(json!({ "tasks": tasks.iter().filter(|task| task.get("scheduledFor").and_then(Value::as_str).is_some_and(|date| date < today)).take(80).collect::<Vec<_>>() }))
        }
        "find_schedule_conflicts" => {
            let tasks = snapshot.get("tasks").and_then(Value::as_array).ok_or("快照缺少任务")?;
            let exceptions = snapshot.get("scheduleExceptions").and_then(Value::as_array).ok_or("快照缺少日程")?;
            Ok(json!({ "tasks": tasks, "scheduleExceptions": exceptions }))
        }
        "search_workbench_memory" => {
            let query = arguments.get("query").and_then(Value::as_str).unwrap_or_default().to_lowercase();
            let memories = snapshot.get("memories").and_then(Value::as_array).ok_or("快照缺少记忆")?;
            Ok(json!({ "memories": memories.iter().filter(|memory| memory.get("value").and_then(Value::as_str).is_some_and(|value| value.to_lowercase().contains(&query))).take(50).collect::<Vec<_>>() }))
        }
        "get_recent_focus_and_checkins" => Ok(json!({ "recentHistory": snapshot.get("recentHistory").cloned().or_else(|| snapshot.get("recentChat").cloned()).unwrap_or(Value::Array(Vec::new())) })),
        "get_pending_proposals" => Ok(json!({ "proposals": snapshot.get("pendingPlanProposals").cloned().unwrap_or(Value::Array(Vec::new())) })),
        _ => Err("未知或不允许的工作台工具".to_owned()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn snapshot() -> Value { json!({ "currentDate": "2026-09-12", "goals": [{"id":"g1","title":"考试"}], "tasks": [{"id":"t1","projectId":"p1","scheduledFor":"2026-09-11"},{"id":"t2","projectId":"p2","scheduledFor":"2026-09-13"}], "scheduleExceptions": [], "memories": [{"value":"晚上学习"}], "pendingPlanProposals": [] }) }

    #[test]
    fn returns_only_tasks_for_requested_project() {
        let result = run("list_project_tasks", &json!({"projectId":"p1"}), &snapshot()).unwrap();
        assert_eq!(result["tasks"].as_array().unwrap().len(), 1);
        assert_eq!(result["tasks"][0]["id"], "t1");
    }

    #[test]
    fn finds_overdue_tasks_against_snapshot_date() {
        let result = run("find_overdue_tasks", &json!({}), &snapshot()).unwrap();
        assert_eq!(result["tasks"].as_array().unwrap().len(), 1);
    }

    #[test]
    fn searches_memory_without_leaving_snapshot() {
        let result = run("search_workbench_memory", &json!({"query":"晚上"}), &snapshot()).unwrap();
        assert_eq!(result["memories"].as_array().unwrap().len(), 1);
    }
}
