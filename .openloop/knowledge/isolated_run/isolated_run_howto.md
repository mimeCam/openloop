`Isolated run` is an idea that allows to quickly check code and logic without unit tests.

Here is how to do it on an example of swift language based project that uses SPM (Swift Package Manager). Similar approach can be used practically in any other programming language using language native tools and frameworks.

1. Define a compilation flag just for the particular feature in `Package.swift`, e.g: `.define("ISOLATED_RUN_FEATUREA", .when(configuration: .debug))`
2. In app's target entrypoint invoke a function of interest before anything else. Allow for minimal (required) initialization if the feature depends on other modules. e.g.: 
```swift
// main.swift
func main() {
    #if ISOLATED_RUN_FEATUREA
    testFileAFeatureA()
    #endif
    
    #if ISOLATED_RUN
    exit(0)
    #endif
}

// fileA.swift
private func featureA() {
    #if ISOLATED_RUN_FEATUREA
    assert(%some-condition%)
    print("OK. ISOLATED_RUN_FEATUREA started.")
    #endif
    
    ... feature implementation code block 1 ...
    
    #if ISOLATED_RUN_FEATUREA
    assert(%some-condition%)
    print("OK. ISOLATED_RUN_FEATUREA checkpoint 1.")
    #endif
    
    ... feature implementation code  block 2...
    
    #if ISOLATED_RUN_FEATUREA
    assert(%some-condition%)
    print("OK. ISOLATED_RUN_FEATUREA completed.")
    #endif
}

#if ISOLATED_RUN_FEATUREA
func testFileAFeatureA() {
    featureA()
}
#endif
```
with such setup it is very easy to toggle a sanity check for any function, any feature, by simply commenting the `.define("ISOLATED_RUN_FEATUREA", .when(configuration: .debug))` line in `Package.swift`. It is also completely normal and safe to leave code with `#if ISOLATED_RUN_FEATUREA ... #endif` - there is no need to delete these sanity checks.
3. `exit(0)` early. Once the feature of interest have been checked - end program early. Since the sanity checks run as part of main app runtime, we don't want to continue running forever since many apps work as services and never finish executing (e.g.: servers that listen on network ports). That's why maintain a `ISOLATED_RUN` define when running in sanity check mode.
4. When app exited early check stdout to ensure that all required prints completed fine. After checking all features and all output, comment sanity defined - do not delete since they may need to be re-enabled later.
