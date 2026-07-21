import Cocoa
import FlutterMacOS

class MainFlutterWindow: NSWindow {
  private var platformLifecycleChannel: PlatformLifecycleChannel?

  override func awakeFromNib() {
    let flutterViewController = FlutterViewController()
    let windowFrame = self.frame
    self.contentViewController = flutterViewController
    self.setFrame(windowFrame, display: true)

    RegisterGeneratedPlugins(registry: flutterViewController)
    platformLifecycleChannel = PlatformLifecycleChannel(
      messenger: flutterViewController.engine.binaryMessenger
    )

    super.awakeFromNib()
  }
}
