// swift-tools-version: 6.0
import PackageDescription

let package = Package(
    name: "Resonance",
    platforms: [.iOS(.v17)],
    products: [.library(name: "Resonance", targets: ["Resonance"])],
    targets: [
        // Web is the built web app (npm run ios:web), served to the page from inside the app.
        .target(name: "Resonance", resources: [.copy("Web")], swiftSettings: [.swiftLanguageMode(.v5)]),
    ]
)
