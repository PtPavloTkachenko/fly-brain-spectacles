# Spectacles Sync Kit (SSK)

The Spectacles Sync Kit (SSK) is a set of tools, components, and assets designed to simplify the development of connected augmented reality experiences for the Spectacles platform in Lens Studio. SSK provides reusable building blocks for synchronizing content and creating a shared, co-located, space.

## Documentation and API Reference

- **Getting Started**: Learn how to use SSK by following the [Get Started Guide](https://developers.snap.com/spectacles/spectacles-frameworks/spectacles-sync-kit/getting-started).

## Release Notes

SSK is updated frequently. Stay informed about the latest features and fixes by checking the [Release Notes](https://developers.snap.com/spectacles/spectacles-frameworks/spectacles-sync-kit/release-notes).

## How to Set Up SSK in Your Project

### If Using a Starter Project
If you’re starting with the "Connected Spectacles" starter project, the setup is already configured for you. You can begin building right away.

### If Adding SSK from the Asset Library
Follow these steps to configure SSK in your project:
1. **Add Device Tracking**: Ensure the main camera in your scene has a Device Tracking component with the tracking mode set to World.
2. **Set Device Type**: In the Preview Panel, set the device type override to Spectacles:
   - Go to the cogwheel in the top-right corner of the Preview Panel.
   - Select Device Type Override > Spectacles.
3. **Ensure SIK is installed**: When installing SSK, SIK (Spectacles Interaction Kit) will be automatically installed to your project. However, you may need to drag the SpectaclesInteractionKit prefab into the Scene Hierarachy.
4. **Add the Prefab**: Drag and drop the SpectaclesSyncKit prefab into the Scene Hierarchy.
5. **Set Platform to Spectacles**: In Project Settings > Platform Settings, select Spectacles and unselect other platforms.

You’re now ready to start building with SSK!