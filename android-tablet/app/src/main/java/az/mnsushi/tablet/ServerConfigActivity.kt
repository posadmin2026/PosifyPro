package az.mnsushi.tablet

import android.content.Intent
import android.os.Bundle
import android.widget.Toast
import androidx.appcompat.app.AppCompatActivity
import az.mnsushi.tablet.databinding.ActivityServerConfigBinding

class ServerConfigActivity : AppCompatActivity() {

    private lateinit var binding: ActivityServerConfigBinding

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        binding = ActivityServerConfigBinding.inflate(layoutInflater)
        setContentView(binding.root)

        binding.serverUrlInput.setText(AppPrefs.getServerUrl(this))
        binding.adminPinInput.setText(AppPrefs.getAdminPin(this))

        binding.saveAndOpenBtn.setOnClickListener {
            val rawUrl = binding.serverUrlInput.text?.toString().orEmpty().trim()
            val pin = binding.adminPinInput.text?.toString().orEmpty().trim()
            if (rawUrl.isBlank()) {
                binding.serverUrlInput.error = getString(R.string.server_url_required)
                return@setOnClickListener
            }
            if (pin.length < 4 || pin.length > 8 || !pin.all { it.isDigit() }) {
                binding.adminPinInput.error = getString(R.string.pin_invalid)
                return@setOnClickListener
            }
            val normalized = normalizeServerUrl(rawUrl)
            AppPrefs.setServerUrl(this, normalized)
            AppPrefs.setAdminPin(this, pin)
            Toast.makeText(this, R.string.settings_saved, Toast.LENGTH_SHORT).show()

            startActivity(Intent(this, MainActivity::class.java))
            finish()
        }
    }

    private fun normalizeServerUrl(input: String): String {
        val url = input.trim().removeSuffix("/")
        return if (url.startsWith("http://") || url.startsWith("https://")) url else "http://$url"
    }
}

