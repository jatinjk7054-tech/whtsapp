import multer from 'multer'

// Applicant photos ship as multipart form data from the public form and are kept
// in memory — the file is forwarded to S3 inside the service, never written to
// disk. 15MB cap is ample for phone camera JPEGs yet bounds a single request.
const fileFilter = (req, file, cb) => {
  if (!file || !file.mimetype || !/^image\//.test(file.mimetype)) {
    return cb(new Error('Only image uploads are allowed'))
  }
  cb(null, true)
}

export const applicationPhotos = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 15 * 1024 * 1024, files: 2 },
  fileFilter,
})