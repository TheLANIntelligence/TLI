Pod::Spec.new do |s|
  s.name           = 'TliTransport'
  s.version        = '0.1.0'
  s.summary        = 'App-scoped certificate-pinned LAN transport for TLI Companion'
  s.description    = s.summary
  s.license        = { :type => 'UNLICENSED' }
  s.author         = 'TheLegatoIntelligence'
  s.homepage       = 'https://github.com/TheLANIntelligence/TLI'
  s.source         = { :git => 'https://github.com/TheLANIntelligence/TLI.git' }
  s.platforms      = { :ios => '16.4' }
  s.swift_version  = '5.9'
  s.static_framework = true
  s.dependency 'ExpoModulesCore'
  s.frameworks = 'Security'
  s.source_files = '**/*.swift'
  s.exclude_files = 'Tests/**'
  s.pod_target_xcconfig = { 'DEFINES_MODULE' => 'YES' }
  s.test_spec 'Tests' do |test_spec|
    test_spec.source_files = 'Tests/**/*.swift'
    test_spec.requires_app_host = false
  end
end
