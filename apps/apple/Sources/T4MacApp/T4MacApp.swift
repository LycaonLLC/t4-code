import SwiftUI
import T4UI

@main
struct T4MacApp: App {
    private let composition = T4Composition.local(bundle: .main)

    var body: some Scene {
        WindowGroup {
            T4RootView(composition: composition)
        }
    }
}
