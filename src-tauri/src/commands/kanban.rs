// Kanban board Tauri commands
// Commands for managing kanban tasks, comments, and project notes

use tracing::debug;

use crate::models::{KanbanStatus, KanbanTask, ProjectNotes};
use crate::storage::{get_storage, StorageError};

fn storage_error_to_string(err: StorageError) -> String {
    err.to_string()
}

/// Get all kanban tasks for a project
#[tauri::command]
pub async fn get_kanban_tasks(project_id: String) -> Result<Vec<KanbanTask>, String> {
    debug!(project_id = %project_id, "Getting kanban tasks");
    let storage = get_storage().map_err(storage_error_to_string)?;
    storage
        .get_kanban_tasks_by_project(&project_id)
        .map_err(storage_error_to_string)
}

/// Add a new kanban task
#[tauri::command]
pub async fn add_kanban_task(
    project_id: String,
    title: String,
    description: String,
) -> Result<KanbanTask, String> {
    debug!(project_id = %project_id, title = %title, "Adding kanban task");
    let storage = get_storage().map_err(storage_error_to_string)?;
    let task = KanbanTask::new(project_id, title, description);
    storage
        .add_kanban_task(task)
        .map_err(storage_error_to_string)
}

/// Update a kanban task
#[tauri::command]
pub async fn update_kanban_task(
    task_id: String,
    title: Option<String>,
    description: Option<String>,
    acceptance_criteria: Option<String>,
    status: Option<KanbanStatus>,
    environment_id: Option<String>,
    build_pipeline_id: Option<String>,
) -> Result<KanbanTask, String> {
    debug!(task_id = %task_id, "Updating kanban task");
    let storage = get_storage().map_err(storage_error_to_string)?;
    storage
        .update_kanban_task(&task_id, title, description, acceptance_criteria, status, environment_id, build_pipeline_id)
        .map_err(storage_error_to_string)
}

/// Delete a kanban task
#[tauri::command]
pub async fn delete_kanban_task(task_id: String) -> Result<(), String> {
    debug!(task_id = %task_id, "Deleting kanban task");
    let storage = get_storage().map_err(storage_error_to_string)?;
    storage
        .delete_kanban_task(&task_id)
        .map_err(storage_error_to_string)
}

/// Add a comment to a kanban task
#[tauri::command]
pub async fn add_kanban_comment(task_id: String, text: String) -> Result<KanbanTask, String> {
    debug!(task_id = %task_id, "Adding comment to kanban task");
    let storage = get_storage().map_err(storage_error_to_string)?;
    storage
        .add_kanban_comment(&task_id, text)
        .map_err(storage_error_to_string)
}

/// Delete a comment from a kanban task
#[tauri::command]
pub async fn delete_kanban_comment(
    task_id: String,
    comment_id: String,
) -> Result<KanbanTask, String> {
    debug!(task_id = %task_id, comment_id = %comment_id, "Deleting kanban comment");
    let storage = get_storage().map_err(storage_error_to_string)?;
    storage
        .delete_kanban_comment(&task_id, &comment_id)
        .map_err(storage_error_to_string)
}

/// Get project notes
#[tauri::command]
pub async fn get_project_notes(project_id: String) -> Result<ProjectNotes, String> {
    debug!(project_id = %project_id, "Getting project notes");
    let storage = get_storage().map_err(storage_error_to_string)?;
    storage
        .get_project_notes(&project_id)
        .map_err(storage_error_to_string)
}

/// Save project notes
#[tauri::command]
pub async fn save_project_notes(
    project_id: String,
    content: String,
) -> Result<ProjectNotes, String> {
    debug!(project_id = %project_id, "Saving project notes");
    let storage = get_storage().map_err(storage_error_to_string)?;
    storage
        .save_project_notes_for_project(&project_id, content)
        .map_err(storage_error_to_string)
}
