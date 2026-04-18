// swift-tools-version: 5.9
import PackageDescription

let package = Package(
    name: "reminders-host",
    platforms: [.macOS(.v14)],
    products: [
        .executable(name: "reminders-host", targets: ["RemindersHost"]),
    ],
    dependencies: [
        .package(url: "https://github.com/hummingbird-project/hummingbird.git", from: "2.0.0"),
    ],
    targets: [
        .executableTarget(
            name: "RemindersHost",
            dependencies: [
                .product(name: "Hummingbird", package: "hummingbird"),
            ]
        ),
    ]
)
