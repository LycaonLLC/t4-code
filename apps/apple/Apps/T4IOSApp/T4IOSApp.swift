import SwiftUI
import T4UI

@main
struct T4IOSApp: App {
    var body: some Scene {
        WindowGroup {
            T4RootView(composition: T4Composition.live())
        }
    }
}
