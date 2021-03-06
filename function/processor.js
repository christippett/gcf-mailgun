'use strict'

const fs = require('fs')
const uuidv4 = require('uuid/v4')
const busboyPromise = require('./busboy.js')
const { filterProperties, convertTimestampToDate } = require('./utils.js')

module.exports = class EmailProcessor {
  constructor ({emailEntity, attachmentEntity, bucketName}, datastore, storage) {
    this.key = datastore.key([emailEntity, uuidv4()])
    this.emailEntity = emailEntity
    this.attachmentEntity = attachmentEntity
    this.bucketName = bucketName
    this.datastore = datastore
    this.storage = storage
  }

  handleRequest (req) {
    return busboyPromise(req)
      .then((parts) => {
        const saveMessage = this.saveMessage(parts.fields)
        const objectPrefix = [parts.fields['recipient'], this.key.path[1]]
        const saveAttachments = this.saveAttachments(parts.files, objectPrefix)
        return Promise.all([saveMessage, saveAttachments])
      })
  }

  saveMessage (fields) {
    // Include only parsed message fields
    // Refer: https://documentation.mailgun.com/en/latest/user_manual.html#parsed-messages-parameters
    const includeFields = [
      'recipient', 'sender', 'from', 'subject', 'body-plain', 'stripped-text',
      'stripped-signature', 'body-html', 'stripped-html', 'attachment-count',
      'timestamp', 'token', 'signature', 'message-headers', 'content-id-map'
    ]
    const excludeFromIndexes = [
      'stripped-text',
      'stripped-html',
      'stripped-signature',
      'body-html',
      'body-plain',
      'message-headers',
      'content-id-map'
    ]
    const data = filterProperties(fields, includeFields)
    if (data.hasOwnProperty('timestamp')) {
      data['timestamp'] = parseInt(data['timestamp'])
      data['date'] = convertTimestampToDate(data['timestamp'])
    }
    if (data.hasOwnProperty('attachment-count')) {
      data['attachment-count'] = parseInt(data['attachment-count'])
    }
    return this.datastore.save({key: this.key, excludeFromIndexes, data})
      .then(() => console.log(`${this.emailEntity} saved with key: ${this.key.path[1]}`))
      .catch((err) => {
        console.error(`Error saving ${this.emailEntity}:`, err)
        return Promise.reject(err)
      })
  }

  saveAttachments (files, objectPrefix) {
    const attachments = []
    for (const name in files) {
      if (files.hasOwnProperty(name)) {
        const file = files[name]
        attachments.push(this.saveAttachment(file, objectPrefix))
      }
    }
    return Promise.all(attachments)
  }

  saveAttachment ({file, filename, encoding, mimeType}, objectPrefix) {
    // Upload to Google Cloud Storage
    const bucketName = this.bucketName
    const bucket = this.storage.bucket(bucketName)
    const destination = objectPrefix.join('/') + '/' + filename
    return bucket
      .upload(file, {destination})
      .then(() => {
        fs.unlinkSync(file)
        console.log(`Uploaded file: ${filename} (gs://${bucketName}/${destination})`)
      })
      .then(() => bucket.file(destination).getMetadata())
      .then((data) => {
        // Save attachment metadata to Datastore
        const metadata = data[0]
        const key = this.datastore.key(this.key.path.concat(this.attachmentEntity))
        const attachment = {
          key,
          data: {
            bucket: metadata.bucket,
            name: metadata.name,
            filename: filename,
            contentType: metadata.contentType,
            size: metadata.size,
            md5Hash: metadata.md5Hash
          }
        }
        return this.datastore.save(attachment)
          .then(() => console.log(`${this.attachmentEntity} (${filename}) saved with key: ${key.path[1]}`))
          .catch((err) => console.error(`Error saving ${this.attachmentEntity} (${filename}):`, err))
      })
      .catch((err) => {
        console.error(`Error uploading file ${filename}: `, err)
        return Promise.reject(err)
      })
  }
}
