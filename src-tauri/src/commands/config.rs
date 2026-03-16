// Configuration management Tauri commands

use crate::models::{AppConfig, GlobalConfig, RepositoryConfig};
use crate::storage::{get_storage, StorageError};

/// Convert storage errors to string for Tauri
fn storage_error_to_string(err: StorageError) -> String {
    err.to_string()
}

/// Get the application configuration
#[tauri::command]
pub async fn get_config() -> Result<AppConfig, String> {
    let storage = get_storage().map_err(storage_error_to_string)?;
    storage.load_config().map_err(storage_error_to_string)
}

/// Save the application configuration
#[tauri::command]
pub async fn save_config(config: AppConfig) -> Result<(), String> {
    let storage = get_storage().map_err(storage_error_to_string)?;
    storage
        .save_config(&config)
        .map_err(storage_error_to_string)
}

/// Get the global configuration
#[tauri::command]
pub async fn get_global_config() -> Result<GlobalConfig, String> {
    let storage = get_storage().map_err(storage_error_to_string)?;
    let config = storage.load_config().map_err(storage_error_to_string)?;
    Ok(config.global)
}

/// Update the global configuration
#[tauri::command]
pub async fn update_global_config(global: GlobalConfig) -> Result<AppConfig, String> {
    println!("[config] update_global_config called");
    println!("[config] Received global config: {:?}", global);

    let storage = get_storage().map_err(|e| {
        let err = storage_error_to_string(e);
        println!("[config] Failed to get storage: {}", err);
        err
    })?;

    let mut config = storage.load_config().map_err(|e| {
        let err = storage_error_to_string(e);
        println!("[config] Failed to load config: {}", err);
        err
    })?;

    println!(
        "[config] Loaded existing config version: {}",
        config.version
    );
    config.global = global;

    storage.save_config(&config).map_err(|e| {
        let err = storage_error_to_string(e);
        println!("[config] Failed to save config: {}", err);
        err
    })?;

    println!("[config] Config saved successfully");
    Ok(config)
}

/// Get repository-specific configuration
#[tauri::command]
pub async fn get_repository_config(project_id: String) -> Result<RepositoryConfig, String> {
    let storage = get_storage().map_err(storage_error_to_string)?;
    let config = storage.load_config().map_err(storage_error_to_string)?;

    Ok(config
        .repositories
        .get(&project_id)
        .cloned()
        .unwrap_or_default())
}

/// Update repository-specific configuration
#[tauri::command]
pub async fn update_repository_config(
    project_id: String,
    repo_config: RepositoryConfig,
) -> Result<AppConfig, String> {
    let storage = get_storage().map_err(storage_error_to_string)?;
    let mut config = storage.load_config().map_err(storage_error_to_string)?;
    config.repositories.insert(project_id, repo_config);
    storage
        .save_config(&config)
        .map_err(storage_error_to_string)?;
    Ok(config)
}

/// Get the path where debug logs are written
#[tauri::command]
pub async fn get_log_directory() -> Result<String, String> {
    Ok(crate::log_dir_path().to_string_lossy().to_string())
}

#[cfg(test)]
mod tests {
    #[test]
    fn test_config_defaults() {
        use crate::models::{AppConfig, GlobalConfig, RepositoryConfig};

        let config = AppConfig::default();
        assert_eq!(config.version, "1.0.0");

        let global = GlobalConfig::default();
        assert_eq!(global.container_resources.cpu_cores, 2);
        assert_eq!(global.container_resources.memory_gb, 4);

        let repo = RepositoryConfig::default();
        assert_eq!(repo.default_branch, "main");
    }
}
