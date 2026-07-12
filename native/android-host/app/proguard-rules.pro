# Keep the Amazon Chime SDK and Flutter embedding from being stripped.
-keep class com.amazonaws.services.chime.** { *; }
-keep class io.flutter.** { *; }
-keep class com.chimeflutter.** { *; }
-dontwarn com.amazonaws.services.chime.**
