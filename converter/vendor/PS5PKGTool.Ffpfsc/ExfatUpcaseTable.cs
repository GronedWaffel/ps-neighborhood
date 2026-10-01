using System.IO.Compression;

namespace PS5PKGTool.Ffpfsc;

/// <summary>Microsoft reference exFAT up-case table used by MkPFS deterministic images.</summary>
internal static class ExfatUpcaseTable
{
    private const int ExpectedLength = 5_836;
    private const string CompressedBase64 =
        "H4sIAAAAAAAC/63YddAWx5YG8J7uGVze4NZvn4YXbzS4uwcLEByChRAghBBCCMHd3d3dnQ/4cHd3QgghBHc/+5Dd2qp72aq7Nr/qP56aOjPd09VjQnhC" +
        "CiV8EYgYIqaIJWKLOCKuiCfiiwQioQiJT0QikVgkEUlFMpFcpBApRSqRWqQRWoSFESSsSCvSiYhILzKIjCKTyCyyiKzCiWwiu8ghcopcIrf4VOQReUU+" +
        "kV8UEAVFIVFYFBFFRTFRXJQQJUUpUVqUEWVFOVFeVBAVRSVRWVQRn4mqopqoLmqImuJzUUvUFnXEF6KuqCfqiwaioWgkGosmoun/qv5n0U38IrqLHqKn" +
        "6CV6iz6ir+gn+osBYqAYJAaLIWKoGCaGixFipBglRosxYqwYJ8aLCWKimCQmiyliqpgmposZYqaYJWaLOWKumCfmiwVioVgkFoslYqlYJpaLFWKlWCVW" +
        "izVirVgn1osNYqPYJDaLLSJKbBXbxHYRLXaInWKX2C32iL1in9gvDoiD4pA4LI6Io+KYOC5OiJPilDgtzoiz4pw4Ly6Ii+KSuCyuiKvi2v+w/sU/1Xfx" +
        "MP2eBB9iQCyIA/EgAYQgESSBZJACUkEaCANBWohABsgEWcBBdsjp5fJyQx7IBwW8glAYikJxKAmloSyUh4peJagCVaE61IRaUAfqQn1oCI2hKTSDFtAK" +
        "WkMbaAvtoQN0hE7QGbp4P8HP8Av08ErLXl5v6Av9vQEwyBvsDYFh3nBvhDfSGwVjvLHec2+8N8GbCEXlFG+qN80jOcObCbNhLsz3FsAib7G3xFsKy70V" +
        "sMpb7a2BdbDB2wibvS1eFGzzXnjR3g5vp7fL2+3tQdvn7Uc76B1COwLH4AScgjNwDi7AJRjuXYXrcANuwi24DXfgLtyHh94j7zHaU3iO872E1/AW3gMW" +
        "v/yw+RADYkEciAcJIASJIAkkgxSQCtJAGEhamRYikAEyQRZwkB1yQm7II/PKfDK/LCALypausCwsi8pWrrgsIUtCaVlGlpXloAJUgipQFarLGrIm5qi/" +
        "V1t+mJm6coRXX470GspGsrFsIsd4X8pmcqzXQraUreRXcgJmqY1s5trKdrK9nOp1kN/Jad73shPmqrP8UXaRP8mu8mfZTbZw3WUPOd/rJXvLRV5f2U/2" +
        "lwPkcq+M/DBjZeUwOVyOkCPlKLnBGyPHynFyvJwgJ8pJcrKcIqfKaXK6nCFnyllytpwj58p5cr5cIBfKRXKxXCKXymVyuVwhV8pVcrVcI9fKdXK93CA3" +
        "yk1ys9wio+RWuU1ul9Fyh9wpd8ndco/cK/fJ/fKAPCgPycPyiDwqj8nj8oQ8KU/J0/KMPCvPyfPygrwoL8nL8oq8Kq/J6/JXeUP+Jm/K3+Ut+Ye8Lf+U" +
        "d+Rf8q68J+/LB/KhfCQfyyfyqXwmn8sX8qV8JV/LN/KtfCffS8at31NSKeWrQMVQMVUsFVvFUXFVPBVfJVAJVUh9ohKpxCqJSqqSqeQqhUqpUqnUKo3S" +
        "KqyMImVVWpVORVR6lUFlVJlUZpVFZVVOZVPZVQ6VU+VSudWnKo/Kq/Kp/KqAKqgKqcKqiCqqiqniqoQqqUqp0qqMKqvKqfKqgqqoKqnKqor6TFVV1VR1" +
        "VUPVVJ+rWqq2qqO+UHVVPVVfNVANVSPVWDVRTdWXqplqrlqolqqV+kq1Vl+rNuob1Va1U+3Vt6qD+k51VN+rTuoH1Vn9qLqon1RX9U69V6y6qx6qp+ql" +
        "eqs+qq/qp/qrAWqgGqQGqyFqqBqmhqsRaqQapUarMWqsGqfGqwlqopqkJqspaqqapqarGWqmmqVmqzlqrpqn5qsFaqFapBarJTjWvx9p5X+jfs5/UT/0" +
        "77MfU8fVCXVSnVKn1Rl1Vp1T5+EiXIarcB1uwE24BbfhDtyF+/BQPVKv1BP1VD1Tz9ULeKVew9v/uAYCN37pK9/3Az+GH9OP5cf24/hx/Xh+fD+Bn9AP" +
        "+Z/4ifzEfhI/qZ/MT+6n8FP6qfzUfhpf+2Hf+ORbP62fzo/46f0MfkY/k5/Zz+Jn9Z2fzc/u5/g/1/+r/jWFZtACWkFraANtoT10gI7QCTpDF+gK3aA7" +
        "9ITefh+/r9/P7+8P8Af6g/zBMBSGw0gYDWNhPEyEyTAVpsNMmA1zYT4shMWwFJbDSlgNa2E9bITNEAXbINrfAbtgD+yDA3AIjkC0fxxOwmk4C+fhIlyG" +
        "q3AdbsBNuAW34Q7chfvwEB7DU3gOL+E1vIX3gNe+QAIubxADYkEciAcJIASJIEmQNEgWJA9SBCmDVEHqIE2gg3BgAgpskDZIF0SC9EGGIGOQKcgcZAmy" +
        "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" +
        "EA7DUTgOJ+E0nIXzcBEuw1W4Djfgpvvd3XJ/uNvuT3fH/eXuunvuvnvgHrpH7rF74p66Z+65e+FeulfutXvj3rp37r1jNzM0KzQ7NCc0NzQvND+0ILQw" +
        "tCi0OLQktDS0LLQ8tCK0MrQqtDq0JrQ2tC60PrQhtDG0KbQ5tCUUFdoa2hbaHooO7QjtDO0K7Q7tCTGnPmk5LafjCKfnDJyRM3FmzsJZ2XE2zs45OCfn" +
        "4tz8KefhvJyP83MBLsiFuAE35EbcmJtwU/6Sm3FzbsEtuRV/xa35a27D33Bbbsft+VvuwN9xR/6eO/EP3Jl/5C78E3fln7kb/8LduQf35F7cm/twX+7H" +
        "/XkAD+RBPJiH8FAexsN5BI/kUTyax/BYHsfjeQJP5Ek8mafwVJ7G03kGz+RZPJvn8Fyex/N5AS/kRbyYl/BSXsbLeQWv5FW8mtfwWl7H63kDb+RNvJm3" +
        "cBRv5W28naN5B+/kXbyb9/Be3sf7+QAf5EN8mI/wUT7Gx/kEn+RTfJrP8Fk+x+f5Al/kS3yZr/BVvsbX+Ve+wb/xTf6db/EffJv/5Dv8F9/le3yfH/BD" +
        "fsSP+Qk/5Wf8nF/wS37Fr/kNv+V3/J6Z/w3TIObzzBYAAA==";

    public static byte[] Create()
    {
        byte[] compressed = Convert.FromBase64String(CompressedBase64);
        using var input = new MemoryStream(compressed, writable: false);
        using var gzip = new GZipStream(input, CompressionMode.Decompress);
        using var output = new MemoryStream(ExpectedLength);
        gzip.CopyTo(output);
        byte[] result = output.ToArray();
        if (result.Length != ExpectedLength)
            throw new InvalidDataException("The embedded exFAT up-case table has an invalid length.");
        return result;
    }
}

