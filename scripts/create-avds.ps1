# Creates the first 4 default AVDs (x86_64 Google APIs images). Extend the list as needed.
$sdk = if ($env:ANDROID_SDK_ROOT) { $env:ANDROID_SDK_ROOT } else { "$env:LOCALAPPDATA\Android\Sdk" }
$sdkmanager = "$sdk\cmdline-tools\latest\bin\sdkmanager.bat"
$avdmanager = "$sdk\cmdline-tools\latest\bin\avdmanager.bat"

$avds = @(
  @{ name = 'PT_Pixel_8_API_35'; api = 35; device = 'pixel_8' },
  @{ name = 'PT_Pixel_7_API_34'; api = 34; device = 'pixel_7' },
  @{ name = 'PT_Pixel_6_API_33'; api = 33; device = 'pixel_6' },
  @{ name = 'PT_Pixel_5_API_31'; api = 31; device = 'pixel_5' }
)
foreach ($a in $avds) {
  $image = "system-images;android-$($a.api);google_apis;x86_64"
  & $sdkmanager $image
  echo no | & $avdmanager create avd --force -n $a.name -k $image -d $a.device
  Write-Host "Created $($a.name)"
}
