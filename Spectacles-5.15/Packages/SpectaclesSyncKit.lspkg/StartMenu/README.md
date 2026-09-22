# Start Menu Controller

The `StartMenuController` provides a centralized way to manage the start menu and auto-start functionality for Spectacles Sync Kit experiences.

## Features

- **Auto-Start Modes**: Configure how the experience should launch
- **Auto-Reconnection**: Automatically retry failed connections with exponential backoff
- **Error Message System**: Centralized error handling with visual feedback
- **API for Manual Control**: Programmatically show the start menu or start multiplayer sessions

## Auto-Start Modes

The controller supports three auto-start modes:

### Menu Mode (Default)
- Always shows the start menu when the lens launches
- Users manually choose between single-player and multiplayer
- Best for most experiences where user choice is important

### Auto-Start Mode
- Automatically attempts to start a multiplayer session on launch
- Shows error messages and retries with exponential backoff on failures
- Does NOT fall back to showing the start menu - designed for multiplayer-only experiences
- Best for experiences designed exclusively for multiplayer

### Off Mode
- Completely disables the start menu
- No automatic initialization of Spectacles Sync Kit
- Best for development and workshop scenarios where you want full manual control

## Configuration

Configure the `StartMenuController` component in the scene inspector:

- **Auto Start Mode**: Choose from Menu, Auto-Start, or Off (defaults to Menu)
- **Start Menu**: Reference to the StartMenu component

Retry behavior is configured via constants in the code:
- **Initial Retry Delay**: 1.0 seconds - starting delay between retry attempts
- **Backoff Multiplier**: 2.0x - exponential backoff factor (1s → 2s → 4s → 8s...)
- **Max Retry Delay**: 30.0 seconds - maximum delay between retry attempts
- **Max Retries**: 5 attempts - maximum number of retry attempts before giving up

## Error Message System

The new `ErrorMessageController` provides centralized error handling:

### Error Types
- **No Internet**: Shown when internet connectivity is unavailable
- **Connection Failed**: Shown when connection attempts fail after all retries

### Error Display Modes
- **With Parent**: Errors can be parented to specific objects (e.g., start menu)
- **Standalone**: Errors appear in front of the user when no parent is specified
- **Auto-Hide**: Errors automatically disappear after 4 seconds

## API Usage

### Show Start Menu Programmatically

```typescript
import { StartMenuController } from "SpectaclesSyncKit/StartMenu/StartMenuController"

// Show the start menu
StartMenuController.getInstance().showStartMenu()
```

### Start Multiplayer Programmatically

```typescript
import { StartMenuController } from "SpectaclesSyncKit/StartMenu/StartMenuController"

// Start multiplayer session directly
StartMenuController.getInstance().startMultiplayer()
```

### Show Error Messages

```typescript
import { ErrorMessageController, ErrorType } from "SpectaclesSyncKit/StartMenu/ErrorMessageController"

// Show error in front of user
ErrorMessageController.getInstance().showError(ErrorType.NoInternet)

// Show error parented to a specific object
ErrorMessageController.getInstance().showError(ErrorType.ConnectionFailed, parentObject)

// Hide specific error
ErrorMessageController.getInstance().hideError(ErrorType.NoInternet)

// Hide all errors
ErrorMessageController.getInstance().hideAllErrors()
```

### Check Current Mode

```typescript
import { StartMenuController, AutoStartMode } from "SpectaclesSyncKit/StartMenu/StartMenuController"

const controller = StartMenuController.getInstance()
const mode = controller.getAutoStartMode()

if (mode === AutoStartMode.AutoStart) {
    console.log("Auto-start mode is enabled")
}
```

## Retry Logic & Behavior Changes

When auto-start mode is enabled and there are connection issues:

### No Internet Available
- Shows "No Internet" error message
- Retries connection attempts with exponential backoff
- **Does NOT** fall back to showing the start menu

### Connection Failures
- Retries automatically with exponential backoff: 1s → 2s → 4s → 8s → 16s → 30s (max)
- After 5 failed attempts, shows "Connection Failed" error
- **Does NOT** fall back to showing the start menu

This prevents overwhelming the servers while providing clear feedback to users in multiplayer-only experiences.

## Scene Hierarchy

The components are organized as follows:

```
SpectaclesSyncKit/
├── SessionController [CONFIGURE_ME]
├── StartMenuController [CUSTOMIZE ME]
│   ├── ErrorMessageController
│   │   ├── NoInternetErrorPrefab (disabled)
│   │   └── ConnectionFailedErrorPrefab (disabled)
│   └── StartMenu/
│       └── NewStartMenu/
│           └── StartMenu UI elements...
```

## Integration with Existing Components

The system maintains backward compatibility while adding new features:

- **StartMenu component** still handles button interactions and single-player logic
- **Error handling** has been moved to the centralized ErrorMessageController
- **Start menu alerts** are now managed by the ErrorMessageController
- **[CUSTOMIZE ME] labels** remind developers to customize the lens title and version

This provides a more robust and flexible foundation for Spectacles Sync Kit experiences.
