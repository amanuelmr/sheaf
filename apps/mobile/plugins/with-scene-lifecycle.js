// iOS 27 stops any app at launch that does not use scenes. Expo ships the scene
// delegate (ExpoAppSceneDelegate) but its template does not use it yet, so this
// names it in Info.plist and lets it, not the app delegate, make the window.
const { withAppDelegate, withInfoPlist } = require('expo/config-plugins');

const PROVIDER = 'ExpoReactNativeFactoryProvider';

function withSceneManifest(config) {
  return withInfoPlist(config, (plist) => {
    plist.modResults.UIApplicationSceneManifest = {
      UIApplicationSupportsMultipleScenes: false,
      UISceneConfigurations: {
        UIWindowSceneSessionRoleApplication: [
          {
            UISceneConfigurationName: 'Default',
            UISceneDelegateClassName: 'EXExpoAppSceneDelegate',
          },
        ],
      },
    };
    return plist;
  });
}

function withSceneAppDelegate(config) {
  return withAppDelegate(config, (delegate) => {
    let source = delegate.modResults.contents;
    if (source.includes(PROVIDER)) return delegate; // already adopted

    const declaration = 'class AppDelegate: ExpoAppDelegate {';
    const window = /#if os\(iOS\) \|\| os\(tvOS\)\n\s*window = UIWindow[\s\S]*?#endif\n/;
    // A template this does not recognise fails the build here, not on a phone.
    if (!source.includes(declaration) || !window.test(source)) {
      throw new Error(
        'with-scene-lifecycle: AppDelegate.swift no longer matches; update the plugin.',
      );
    }
    source = source.replace(declaration, `class AppDelegate: ExpoAppDelegate, ${PROVIDER} {`);
    source = source.replace(
      window,
      '    // The scene delegate makes the window and starts React Native in it.\n',
    );
    delegate.modResults.contents = source;
    return delegate;
  });
}

module.exports = (config) => withSceneAppDelegate(withSceneManifest(config));
